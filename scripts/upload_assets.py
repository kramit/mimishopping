#!/usr/bin/env python3
"""Resumable, checksum-verified transfer for Mimi's public gallery assets."""

from __future__ import annotations

import argparse
import base64
import csv
import hashlib
import json
import mimetypes
import os
import pathlib
import sys
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import quote

from azure.identity import AzureCliCredential
from azure.storage.blob import BlobServiceClient, ContentSettings

LOCK = threading.Lock()
CACHE_CONTROL = 'public, max-age=31536000, immutable'


def digest_file(path: pathlib.Path) -> tuple[str, str, int]:
    sha = hashlib.sha256()
    md5 = hashlib.md5()
    size = 0
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            size += len(chunk)
            sha.update(chunk)
            md5.update(chunk)
    return sha.hexdigest(), base64.b64encode(md5.digest()).decode('ascii'), size


def load_source_hashes(manifest_path: pathlib.Path) -> dict[str, str]:
    with manifest_path.open(newline='', encoding='utf-8') as stream:
        return {row['current_path']: row['sha256'] for row in csv.DictReader(stream)}


def gather_assets(shopping_root: pathlib.Path, catalog_manifest: pathlib.Path) -> list[dict]:
    photos = shopping_root / 'Photos'
    thumbs = shopping_root / 'Catalog' / 'thumbnails'
    previews = shopping_root / 'Catalog' / 'previews'
    expected = load_source_hashes(catalog_manifest)
    assets = []
    original_count = 0
    for kind, root, prefix in (
        ('photo', photos, 'photos'),
        ('thumbnail', thumbs, 'thumbnails'),
        ('preview', previews, 'previews'),
    ):
        for path in sorted(root.rglob('*')):
            if not path.is_file() or path.name == '.DS_Store':
                continue
            relative = path.relative_to(root).as_posix()
            sha, md5, size = digest_file(path)
            if kind == 'photo':
                original_count += 1
                ledger_path = f'Photos/{relative}'
                if expected.get(ledger_path) != sha:
                    raise ValueError(f'Original does not match the catalog SHA-256 ledger: {ledger_path}')
            assets.append({
                'kind': kind,
                'source': str(path),
                'relativePath': f'{kind}/{relative}',
                'blobName': f'{prefix}/{relative}',
                'sha256': sha,
                'contentMd5': md5,
                'size': size,
                'status': 'pending',
            })
    if original_count != 741 or sum(a['kind'] == 'thumbnail' for a in assets) != 741 or sum(a['kind'] == 'preview' for a in assets) != 2:
        raise ValueError('Asset inventory changed: expected 741 originals, 741 thumbnails, and 2 HEIC previews.')
    rendition_manifest = shopping_root / 'Catalog' / 'optimized-v1-manifest.jsonl'
    rendition_root = shopping_root / 'Catalog'
    rendition_rows = [json.loads(line) for line in rendition_manifest.read_text(encoding='utf-8').splitlines() if line.strip()]
    if len(rendition_rows) != 741 or len({row.get('id') for row in rendition_rows}) != 741:
        raise ValueError('Expected 741 unique, completed image rendition records.')
    source_by_id = {}
    with catalog_manifest.open(newline='', encoding='utf-8') as stream:
        for row in csv.DictReader(stream):
            source_by_id[row['image_id']] = (row['current_path'].replace('\\', '/'), row['sha256'].lower())
    rendition_count = 0
    for row in rendition_rows:
        source = source_by_id.get(row.get('id'))
        if row.get('status') != 'verified' or not source or (row.get('sourcePath'), row.get('sourceSha256')) != source:
            raise ValueError(f'Incomplete or mismatched rendition record: {row.get("id")}')
        outputs = row.get('outputs') or {}
        expected_outputs = {
            f'optimized-v1/thumbnails/{row["id"]}.jpg',
            f'optimized-v1/thumbnails/{row["id"]}.webp',
            f'optimized-v1/display/{row["id"]}.jpg',
            f'optimized-v1/display/{row["id"]}.webp',
        }
        if set(outputs) != expected_outputs:
            raise ValueError(f'Rendition output set is incomplete for {row["id"]}.')
        for relative, output in outputs.items():
            path = rendition_root / relative
            sha, md5, size = digest_file(path)
            if output.get('status') != 'verified' or output.get('sha256') != sha or output.get('bytes') != size:
                raise ValueError(f'Rendition file does not match its manifest: {path}')
            assets.append({
                'kind': 'rendition', 'source': str(path), 'relativePath': relative,
                'blobName': relative, 'sha256': sha, 'contentMd5': md5,
                'size': size, 'status': 'pending', 'sourceImageId': row['id'],
                'sourcePath': row['sourcePath'], 'sourceSha256': row['sourceSha256'],
            })
            rendition_count += 1
    if rendition_count != 741 * 4:
        raise ValueError(f'Expected 2,964 rendition files; found {rendition_count}.')
    if len({asset['blobName'] for asset in assets}) != len(assets):
        raise ValueError('Two source assets map to the same Blob path.')
    return assets


def write_manifest(path: pathlib.Path, assets: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + '.tmp')
    with temporary.open('w', encoding='utf-8') as stream:
        for asset in assets:
            stream.write(json.dumps(asset, ensure_ascii=False, separators=(',', ':')) + '\n')
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(path)


def append_manifest_update(path: pathlib.Path, asset: dict) -> None:
    with path.open('a', encoding='utf-8') as stream:
        stream.write(json.dumps(asset, ensure_ascii=False, separators=(',', ':')) + '\n')
        stream.flush()
        os.fsync(stream.fileno())


def load_or_create_manifest(path: pathlib.Path, current: list[dict]) -> list[dict]:
    if not path.exists():
        write_manifest(path, current)
        return current
    existing = [json.loads(line) for line in path.read_text(encoding='utf-8').splitlines() if line.strip()]
    indexed = {}
    for item in existing:
        previous = indexed.get(item['blobName'])
        if previous and (previous.get('sha256') != item.get('sha256') or previous.get('source') != item.get('source')):
            raise ValueError(f'Saved upload manifest has conflicting history for {item["blobName"]}.')
        indexed[item['blobName']] = item
    current_by_blob = {item['blobName']: item for item in current}
    removed = set(indexed) - set(current_by_blob)
    if removed:
        raise ValueError(f'Saved upload manifest contains {len(removed)} paths missing from the current inventory; inspect before proceeding.')
    for item in current:
        previous = indexed.get(item['blobName'])
        if previous and (previous.get('sha256') != item['sha256'] or previous.get('source') != item['source']):
            raise ValueError(f'Source changed since the saved manifest: {item["blobName"]}')
        if previous:
            for key in ('status', 'verifiedAt', 'note', 'downloadHeaderVerified', 'contentTypeVerified'):
                if key in previous:
                    item[key] = previous[key]
    write_manifest(path, current)
    return current


def content_type(path: pathlib.Path) -> str:
    if path.suffix.lower() == '.heic':
        return 'image/heic'
    return mimetypes.guess_type(path.name)[0] or 'application/octet-stream'


def content_disposition(path: pathlib.Path) -> str:
    filename = path.name
    ascii_name = ''.join(char if 32 <= ord(char) < 127 and char not in '"\\' else '_' for char in filename)
    encoded = quote(filename.encode('utf-8'), safe="!#$&+-.^_`|~")
    return f'attachment; filename="{ascii_name}"; filename*=UTF-8\'\'{encoded}'


def ensure_http_headers(client, asset: dict, properties=None) -> tuple[bool, bool]:
    properties = properties or client.get_blob_properties()
    prior = properties.content_settings
    path = pathlib.Path(asset['source'])
    desired_type = content_type(path)
    desired_disposition = prior.content_disposition
    if asset['kind'] == 'photo' and not asset.get('skipDownloadHeader'):
        desired_disposition = content_disposition(path)
    if prior.content_type != desired_type or prior.content_disposition != desired_disposition:
        settings = ContentSettings(
            content_type=desired_type,
            content_encoding=prior.content_encoding,
            content_language=prior.content_language,
            content_disposition=desired_disposition,
            cache_control=prior.cache_control or CACHE_CONTROL,
            content_md5=prior.content_md5,
        )
        client.set_http_headers(content_settings=settings)
        properties = client.get_blob_properties()
    if properties.content_settings.content_type != desired_type:
        raise ValueError(f'Blob content-type verification failed: {asset["blobName"]}')
    download_header_verified = asset['kind'] == 'photo' and not asset.get('skipDownloadHeader')
    if download_header_verified and properties.content_settings.content_disposition != desired_disposition:
        raise ValueError(f'Original download header verification failed: {asset["blobName"]}')
    return download_header_verified, True


def transfer_one(service: BlobServiceClient, asset: dict) -> tuple[str, str]:
    client = service.get_blob_client(container='gallery', blob=asset['blobName'])
    try:
        properties = client.get_blob_properties()
        if (properties.metadata or {}).get('sha256') == asset['sha256'] and properties.content_settings.content_md5 and base64.b64encode(properties.content_settings.content_md5).decode('ascii') == asset['contentMd5']:
            header_set, content_type_set = ensure_http_headers(client, asset, properties)
            asset['downloadHeaderVerified'] = header_set or None
            asset['contentTypeVerified'] = content_type_set
            note = 'remote metadata and MD5 match; download header verified' if header_set else 'remote metadata and MD5 match'
            if asset.get('skipDownloadHeader'):
                note = 'remote metadata and MD5 match; download header deferred until gallery switch'
            return 'verified', note
    except Exception as error:
        if getattr(error, 'status_code', None) != 404:
            raise
    path = pathlib.Path(asset['source'])
    settings = ContentSettings(content_type=content_type(path), cache_control=CACHE_CONTROL, content_md5=base64.b64decode(asset['contentMd5']), content_disposition=content_disposition(path) if asset['kind'] == 'photo' and not asset.get('skipDownloadHeader') else None)
    with path.open('rb') as stream:
        client.upload_blob(stream, length=asset['size'], overwrite=True, metadata={'sha256': asset['sha256']}, content_settings=settings, validate_content=True, max_concurrency=2)
    properties = client.get_blob_properties()
    remote_md5 = base64.b64encode(properties.content_settings.content_md5 or b'').decode('ascii')
    remote_sha = (properties.metadata or {}).get('sha256')
    if remote_md5 != asset['contentMd5'] or remote_sha != asset['sha256']:
        raise ValueError(f'Azure checksum verification failed: {asset["blobName"]}')
    header_set, content_type_set = ensure_http_headers(client, asset, properties)
    asset['downloadHeaderVerified'] = header_set or None
    asset['contentTypeVerified'] = content_type_set
    return 'verified', 'uploaded and remote checksums match'


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--account-name', required=True)
    parser.add_argument('--shopping-root', type=pathlib.Path, required=True)
    parser.add_argument('--catalog-manifest', type=pathlib.Path, required=True)
    parser.add_argument('--transfer-manifest', type=pathlib.Path, required=True)
    parser.add_argument('--workers', type=int, default=4)
    parser.add_argument('--skip-download-headers', action='store_true', help='Defer original attachment headers until after the optimized gallery is live.')
    parser.add_argument('--headers-only', action='store_true', help='Verify/update attachment headers only for original photo blobs.')
    args = parser.parse_args()
    current = gather_assets(args.shopping_root, args.catalog_manifest)
    assets = load_or_create_manifest(args.transfer_manifest, current)
    if args.skip_download_headers:
        for asset in assets:
            if asset['kind'] == 'photo': asset['skipDownloadHeader'] = True
    transfer_assets = [asset for asset in assets if asset['kind'] == 'photo'] if args.headers_only else assets
    if args.headers_only:
        for asset in transfer_assets: asset.pop('skipDownloadHeader', None)
    service = BlobServiceClient(
        account_url=f'https://{args.account_name}.blob.core.windows.net',
        credential=AzureCliCredential(),
    )
    failures = []
    processed = 0
    with ThreadPoolExecutor(max_workers=max(1, min(args.workers, 8))) as pool:
        futures = {pool.submit(transfer_one, service, asset): asset for asset in transfer_assets}
        for future in as_completed(futures):
            asset = futures[future]
            try:
                status, note = future.result()
                asset.update(status=status, note=note, verifiedAt=__import__('datetime').datetime.now(__import__('datetime').timezone.utc).isoformat())
            except Exception as error:
                asset.update(status='failed', note=f'{type(error).__name__}: {error}')
                failures.append(asset['blobName'])
            with LOCK:
                append_manifest_update(args.transfer_manifest, asset)
            processed += 1
            if processed % 50 == 0 or processed == len(transfer_assets):
                print(f'{processed}/{len(transfer_assets)} processed; {len(failures)} failed')
    with LOCK:
        write_manifest(args.transfer_manifest, assets)
    counts = {status: sum(item['status'] == status for item in transfer_assets) for status in ('verified', 'failed', 'pending')}
    print(json.dumps({'account': args.account_name, 'objects': len(transfer_assets), 'totalManifestObjects': len(assets), 'counts': counts, 'manifest': str(args.transfer_manifest)}, indent=2))
    return 1 if failures or counts['pending'] else 0


if __name__ == '__main__':
    sys.exit(main())

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


def load_or_create_manifest(path: pathlib.Path, current: list[dict]) -> list[dict]:
    if not path.exists():
        write_manifest(path, current)
        return current
    existing = [json.loads(line) for line in path.read_text(encoding='utf-8').splitlines() if line.strip()]
    if len(existing) != len(current):
        raise ValueError('Saved upload manifest has a different asset count; inspect it before proceeding.')
    indexed = {item['blobName']: item for item in existing}
    for item in current:
        previous = indexed.get(item['blobName'])
        if not previous or previous.get('sha256') != item['sha256'] or previous.get('source') != item['source']:
            raise ValueError(f'Source changed since the saved manifest: {item["blobName"]}')
        item['status'] = previous.get('status', 'pending')
        item['verifiedAt'] = previous.get('verifiedAt')
    return current


def content_type(path: pathlib.Path) -> str:
    if path.suffix.lower() == '.heic':
        return 'image/heic'
    return mimetypes.guess_type(path.name)[0] or 'application/octet-stream'


def transfer_one(service: BlobServiceClient, asset: dict) -> tuple[str, str]:
    client = service.get_blob_client(container='gallery', blob=asset['blobName'])
    try:
        properties = client.get_blob_properties()
        if (properties.metadata or {}).get('sha256') == asset['sha256'] and properties.content_settings.content_md5 and base64.b64encode(properties.content_settings.content_md5).decode('ascii') == asset['contentMd5']:
            return 'verified', 'remote metadata and MD5 match'
    except Exception as error:
        if getattr(error, 'status_code', None) != 404:
            raise
    path = pathlib.Path(asset['source'])
    settings = ContentSettings(content_type=content_type(path), cache_control=CACHE_CONTROL, content_md5=base64.b64decode(asset['contentMd5']))
    with path.open('rb') as stream:
        client.upload_blob(stream, length=asset['size'], overwrite=True, metadata={'sha256': asset['sha256']}, content_settings=settings, validate_content=True, max_concurrency=2)
    properties = client.get_blob_properties()
    remote_md5 = base64.b64encode(properties.content_settings.content_md5 or b'').decode('ascii')
    remote_sha = (properties.metadata or {}).get('sha256')
    if remote_md5 != asset['contentMd5'] or remote_sha != asset['sha256']:
        raise ValueError(f'Azure checksum verification failed: {asset["blobName"]}')
    return 'verified', 'uploaded and remote checksums match'


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--account-name', required=True)
    parser.add_argument('--shopping-root', type=pathlib.Path, required=True)
    parser.add_argument('--catalog-manifest', type=pathlib.Path, required=True)
    parser.add_argument('--transfer-manifest', type=pathlib.Path, required=True)
    parser.add_argument('--workers', type=int, default=4)
    args = parser.parse_args()
    current = gather_assets(args.shopping_root, args.catalog_manifest)
    assets = load_or_create_manifest(args.transfer_manifest, current)
    service = BlobServiceClient(
        account_url=f'https://{args.account_name}.blob.core.windows.net',
        credential=AzureCliCredential(),
    )
    failures = []
    with ThreadPoolExecutor(max_workers=max(1, min(args.workers, 8))) as pool:
        futures = {pool.submit(transfer_one, service, asset): asset for asset in assets}
        for future in as_completed(futures):
            asset = futures[future]
            try:
                status, note = future.result()
                asset.update(status=status, note=note, verifiedAt=__import__('datetime').datetime.now(__import__('datetime').timezone.utc).isoformat())
            except Exception as error:
                asset.update(status='failed', note=f'{type(error).__name__}: {error}')
                failures.append(asset['blobName'])
            with LOCK:
                write_manifest(args.transfer_manifest, assets)
            completed = sum(item['status'] == 'verified' for item in assets)
            if completed % 50 == 0 or completed == len(assets):
                print(f'{completed}/{len(assets)} verified; {len(failures)} failed')
    counts = {status: sum(item['status'] == status for item in assets) for status in ('verified', 'failed', 'pending')}
    print(json.dumps({'account': args.account_name, 'objects': len(assets), 'counts': counts, 'manifest': str(args.transfer_manifest)}, indent=2))
    return 1 if failures or counts['pending'] else 0


if __name__ == '__main__':
    sys.exit(main())

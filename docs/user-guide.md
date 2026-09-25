# User guide

## Browse the collection

Use **Search** for a product, brand, filename, Japanese text, translation, tag, or research term. The Category, Tag, Trip / date, Trip year, and Web research selectors narrow the results together. Trip groups are approximate because some dates come from photo filenames. Open **Browse by tag** to pick a common tag; **Show all tags** expands beyond the first 60. Click a tag on a photo card to apply that filter; selecting the same tag again in the tag cloud clears it.

Choose **Photos** for individual images or **Products** for groups of photos identified as the same item. The Products view can list one photo in more than one group if it contains several products. **View photos and research** opens a group with related photos and research; opening an individual photo shows its description, identified products, Japanese text with English translations, source links where available, and **Save Image**. Use Previous and Next to move through long result sets.

Research badges say Matched, Partial, Pending, or No match. These indicate the catalog's research state, not a guarantee about current prices or stock. Some photos are flagged for closer inspection. **Photo review only** filters to unchecked flagged photos in this browser. The **Photo review queue** and detail dialog let you mark one checked or undo it. Those checks stay in this browser and do not change the shared catalog.

## Add a photo

Choose **Take a photo** for one camera image or **Choose from camera roll** for one or more saved images. Supported files are JPEG, PNG, WebP, HEIC, and AVIF, up to 24 MiB each. Camera-roll uploads continue processing in the background; the private upload list shows each photo's progress and lets you return to a result later. The page stores the draft access token in this browser's local storage. Use a private browser profile if the photo or research should not be accessible to another person using the same device.

Once analysis completes, choose **Review result**. Inspect the preview, identification, Japanese translations, research, and sources. You can adjust **Category** and comma-separated **Tags**, then enter a **Contributor name**. Selecting **Add to catalog** starts publication; it may take a little longer before the item appears at the top of the gallery. The photo, research, tags, and contributor name become public when publication finishes. A blank contributor name cannot be published.

If processing fails, choose **Retry** or **Retry processing**. If the upload itself was interrupted, choose the same photo again to resume. **Close result** leaves the private draft in your list. **Discard and don't add to catalog** asks for confirmation and marks the private draft for deletion. Unpublished drafts expire after 30 days and a daily cleanup timer removes them after expiry when it runs successfully. An exact photo already uploaded privately by another browser cannot be opened with its image ID alone.

## Editor controls

Select **Editor sign in** and use an invited Microsoft Entra account with the `catalog_editor` role. An editor can open a photo, choose **Edit tags**, save a shared override, or **Restore catalog tags**. In a product group, the editor can add or remove tags across every related photo. **Export tag backup** saves tag overrides and local review checks as JSON; **Import tag backup** applies its recognized tag edits to the shared catalog and restores review checks locally. If another editor changed a tag in the meantime, reload before trying again.

For a published community photo, the editor can update the public contributor name or choose **Hide contribution**. Hiding removes it from the public catalog and queues deletion of its public photo. Photo review checks remain local even when signed in. Use **Sign out** when finished.

The site needs its Azure API for shared edits, private uploads, and new community photos. A static local preview can show the shipped gallery but those cloud actions will not work there. For implementation details, see [architecture](architecture.md), [Functions reference](functions.md), and [deployment](../DEPLOYMENT.md).

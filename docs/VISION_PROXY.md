# Vision Proxy

AporiaX can use a separate vision model when the selected main model cannot read images. The main reasoning model does not need to change.

## Behavior

- If the selected main model supports image input natively, AporiaX keeps the native multimodal path and sends the image directly to that model.
- If the selected main model is text-only, AporiaX can use Aporia Cloud Vision or a configured image-capable Provider as a visual proxy.
- A text-only local model can therefore keep all normal reasoning/tool turns on its local endpoint while borrowing only image understanding from Aporia Cloud.
- Aporia Cloud Vision uses the signed-in Aporia Account session and the hidden `aporia-cloud-vision` model (`Qwen3.5 Flash Vision`). Desktop never receives the upstream Qwen API key.
- Cloud Vision is invoked only when an image attachment is present. It converts the image to a compact structured text observation before the Harness Agent loop starts.
- The raw image is removed from the text-only main-model request after visual analysis. The main model receives the user's text plus the visual observation.
- Non-image attachments remain unchanged.
- Aporia Cloud Vision processes one inline image per Cloud request. Messages with several images are processed sequentially, preventing the hidden Cloud endpoint from becoming a generic remote-image fetcher.
- If Cloud Vision cannot be used, AporiaX falls back to an explicitly selected or configured user vision Provider when available.

The proxy recognizes the existing AporiaX vision model patterns plus Qwen 3.5/3.6/3.7 model IDs. For user Providers it prefers `qwen3.5-flash`, then dated Qwen3.5 Flash releases, Qwen3.6 Flash, and Qwen3-VL Flash when multiple visual models are exposed.

## Local model + Aporia Cloud Vision

The intended hybrid route is:

```text
User + image
    ↓
Local/custom text model selected
    ↓
Aporia Cloud Vision (Qwen3.5 Flash)
    ↓
structured visual observation
    ↓
original local/custom model
    ↓
reasoning + tools + file changes stay on the selected main model
```

This route does not turn the whole task into an Aporia Cloud model request. Only the image-understanding call uses the Cloud weekly quota.

The Desktop keeps two persisted hybrid-routing controls in the Vision capability card when a local/custom main model is borrowing Aporia Cloud Vision:

- **Cloud vision enhancement** — enabled by default. Disable it to prevent local/custom text models from automatically borrowing Aporia Cloud Vision.
- **20% low-quota guard** — enabled by default. Immediately before the managed visual call, Desktop refreshes the Aporia Account state and checks the current weekly remaining ratio. At or below 20%, automatic Cloud Vision is paused. The Account refresh itself does not invoke a model or consume model quota. The user can disable this guard if they deliberately want to continue using vision.

These hybrid controls do not change the normal hidden vision preprocessing used when the main model itself is an Aporia Cloud text model.

If the Account is signed out, Aporia Cloud is not advertised as an available visual proxy. Existing user-configured vision Providers can still be used.

## Task settings feedback

The task settings sidebar distinguishes native image support from effective image support:

- **Native vision** means the selected main model can consume the image itself.
- **Vision proxy** means the selected main model is text-only, but AporiaX has a visual model that can inspect the image first.
- **Unavailable** means the current main model is text-only and there is no usable visual route.

When a local/custom main model uses Aporia Cloud as the proxy, the card shows the main model → Qwen3.5 Flash Vision route, the Cloud enhancement switch, the low-quota guard, and the most recently synchronized remaining quota percentage when available. The guard refreshes Account state again immediately before an actual Cloud Vision call.

Provider listings expose this distinction with `nativeSupportsImages`, `supportsImageProxy`, `supportsImages` (effective renderer capability), and a non-secret `visionProxy` descriptor. API keys remain main-process only.

## User-configured Qwen3.5 Flash

Aporia Cloud is not required. A user can still add Alibaba Cloud Model Studio as a normal OpenAI-compatible Provider:

1. Create a Model Studio API key.
2. Add the OpenAI-compatible Base URL for the Model Studio region/workspace. The URL should end in `/compatible-mode/v1`.
3. Add model ID `qwen3.5-flash`.
4. Save the Provider.
5. Keep a text-only model selected as the main model and attach an image.

When the managed Cloud route is unavailable or deliberately disabled, AporiaX can fall back to this configured visual Provider.

## Security and privacy

Aporia Cloud Vision authenticates through the Desktop Aporia Account session. The upstream Qwen credential remains server-side in AporiaX Cloud and is never stored in Desktop, exposed to the renderer, or returned by the model catalog.

User Provider API keys remain in the Electron main process and continue to use the existing `safeStorage` encrypted Provider store. The renderer never receives decrypted vision keys.

When the main model is text-only, image attachments may be sent to the selected visual service for analysis. The main local model receives only the resulting text observation. Users should keep Cloud vision disabled for projects whose images must never leave the machine.

## Current scope

Included:

- local/custom text model → Aporia Cloud Vision → local/custom model hybrid route
- signed-in Account gating
- Cloud weekly-quota accounting through the existing model gateway
- persisted hybrid Cloud Vision on/off control
- default 20% low-quota protection with pre-call Account refresh
- user-provider visual fallback
- OpenAI-compatible Chat Completions vision requests
- data-URL image attachments already accepted by AporiaX
- compact text observations returned before the main Agent loop
- renderer feedback for native, proxied, protected, disabled, and unavailable states

Not included yet:

- per-project vision routing policy
- user-adjustable quota-guard threshold
- image-observation cache
- OCR-specific routing
- visual verification / screenshot test loop

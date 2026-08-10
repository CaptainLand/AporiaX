# Vision Proxy

AporiaX can use a separate OpenAI-compatible vision model when the selected main model cannot read images.

## Behavior

- If the selected main model supports image input, AporiaX keeps the existing native multimodal path and sends the image directly to that model.
- If the selected main model is text-only, AporiaX looks for a configured Provider with an image-capable model.
- The image-capable model receives only the image attachment(s) and the accompanying user text. It returns a compact visual observation.
- The original image attachment is then removed from the text-only model request and the visual observation is appended to the user message.
- Non-image attachments remain unchanged.
- If no image-capable Provider is configured, the existing text-only behavior remains unchanged.

The proxy currently recognizes the existing AporiaX vision model patterns plus Qwen 3.5/3.6/3.7 model IDs. This lets `qwen3.5-flash` act as the vision model even when an older saved Provider record marked it as `supportsImages: false`.

## Qwen3.5-Flash

No dedicated Qwen SDK is required. Add Alibaba Cloud Model Studio as a normal AporiaX OpenAI-compatible Provider:

1. Create a Model Studio API key.
2. Add the OpenAI-compatible Base URL for your Model Studio region/workspace. The URL should end in `/compatible-mode/v1`.
3. Add model ID `qwen3.5-flash`.
4. Save the Provider.
5. Keep DeepSeek V4 (or another text-only model) selected as the main model and attach an image to a task.

AporiaX will automatically use the configured image-capable Provider as the visual fallback.

## Security and privacy

Provider API keys remain in the Electron main process and continue to use the existing `safeStorage` encrypted Provider store. The renderer never receives the decrypted vision key.

When the main model is text-only, image attachments may be sent to a different configured Provider for visual analysis. Only configure a vision Provider if sending those attachments to that service is acceptable for the project and data involved.

## Current scope

This first implementation is deliberately small:

- OpenAI-compatible Chat Completions vision requests
- data-URL image attachments already accepted by AporiaX
- up to 8 images from one message
- 60 second vision request timeout
- compact text observation returned to the main model

Not included yet:

- dedicated Vision Provider picker in Settings
- per-project vision routing policy
- image-observation cache
- OCR-specific routing
- visual verification / screenshot test loop

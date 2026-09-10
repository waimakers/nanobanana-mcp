# Nanobanana MCP quick reference

Set a dedicated key before launching the MCP client:

```bash
export NANOBANANA_COHORT_API_KEY="your-dedicated-cohort-key"
```

The checked-in [`.mcp.json`](.mcp.json) maps that variable to `GEMINI_IMAGE_API_KEY`. The server also accepts `GEMINI_API_KEY` when used outside the cohort configuration.

Use Flash at 1K for workshop throughput while retaining the existing default for other installations:

```bash
export NANOBANANA_DEFAULT_MODEL="gemini-3.1-flash-image"
export NANOBANANA_DEFAULT_IMAGE_SIZE="1K"
```

Generate:

```json
{
  "prompt": "A warm editorial illustration of a banana workshop, clear typography, 16:9",
  "model": "gemini-3.1-flash-image",
  "imageSize": "1K",
  "aspectRatio": "16:9",
  "outputPath": "generated/workshop.png"
}
```

Edit with an image reference:

```json
{
  "prompt": "Replace the background with a bright studio setting",
  "inputImage": { "source": "file_path", "filePath": "input.png" },
  "model": "gemini-3.1-flash-image",
  "imageSize": "1K"
}
```

Use an existing Google Files URI:

```json
{
  "prompt": "Create a matching poster",
  "referenceImages": [{ "source": "file_uri", "fileUri": "files/example" }]
}
```

Stable choices are `gemini-3.1-flash-image`, `gemini-3-pro-image`, and `gemini-3.1-flash-lite-image`. The legacy `nano-banana-pro-preview` remains available and maps to `gemini-3-pro-image-preview`; preview and 2.5 choices remain supported for existing callers.

`maskImage` and other references guide generative output only. They are not an exact selection mask. The shared cohort key makes `list_uploaded_files` and `delete_uploaded_file` visible to everyone using the key; do not upload confidential images.

With the cohort configuration, paths must stay inside the workspace where you launch the client. Copy input images there first. Existing output files are not overwritten. URL references must be direct public HTTPS images; redirects and private-network addresses are rejected.

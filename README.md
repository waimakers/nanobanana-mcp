# 🍌 Nanobanana MCP Server

MCP server for Google's **Gemini Pro Image** (Nanobanana) API - AI-powered image generation with style reference support.

## ✨ Features

- 🎨 **Image Generation** - Create images from text prompts
- 🖼️ **Style Transfer** - Use reference images for style guidance
- 📤 **File Upload** - Automatic upload of reference images to Google Files API
- 🔄 **Multiple Formats** - Support for various aspect ratios and sizes
- 💾 **Save to Disk** - Option to save generated images directly

## 🚀 Quick Start

### 1. Installation

```bash
cd nanobanana-mcp
npm install
npm run build
```

### 2. Get Your API Key

1. Go to [Google AI Studio](https://aistudio.google.com/app/apikey)
2. Create a new API key
3. Copy the key

### 3. Configure Environment

```bash
cp environment.template .env
```

Edit `.env` and add your API key:

```env
GEMINI_API_KEY=your_api_key_here
DEBUG=false
```

### 4. Test the Server

```bash
npm start
```

## 🔧 MCP Configuration

Add to your `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "nanobanana": {
      "command": "node",
      "args": ["/path/to/nanobanana-mcp/dist/index.js"],
      "env": {
        "GEMINI_API_KEY": "your_api_key_here"
      }
    }
  }
}
```

## 🛠️ Available Tools

### 1. `upload_test_image`

Test uploading an image to Google Files API.

**Parameters:**
- `filePath` (string, required) - Absolute path to the image file
- `displayName` (string, optional) - Display name for the file

**Example:**
```json
{
  "filePath": "/path/to/test-image.jpg",
  "displayName": "My Test Image"
}
```

### 2. `generate_image`

Generate an image using Gemini Pro Image.

**Parameters:**
- `prompt` (string, required) - Text description of the image
- `referenceImagePath` (string, optional) - Path to reference image for style
- `aspectRatio` (string, optional) - One of: `1:1`, `16:9`, `9:16`, `3:4`, `4:3`
- `imageSize` (string, optional) - One of: `256x256`, `512x512`, `1K`, `2K`, `4K`
- `outputPath` (string, optional) - Where to save the generated image

**Example:**
```json
{
  "prompt": "A serene mountain landscape at sunset",
  "aspectRatio": "16:9",
  "imageSize": "2K",
  "outputPath": "/path/to/output/generated-image.png"
}
```

**With reference image:**
```json
{
  "prompt": "Generate a portrait in this artistic style",
  "referenceImagePath": "/path/to/reference.jpg",
  "aspectRatio": "1:1",
  "imageSize": "1K",
  "outputPath": "/path/to/output/styled-portrait.png"
}
```

### 3. `list_uploaded_files`

List all files uploaded to Google Files API.

**Parameters:** None

### 4. `delete_uploaded_file`

Delete an uploaded file from Google Files API.

**Parameters:**
- `fileName` (string, required) - File name to delete (e.g., `files/abc123`)

## 📝 Usage Examples

### Test File Upload

```
@nanobanana upload_test_image {
  "filePath": "/path/to/test.jpg"
}
```

### Generate Simple Image

```
@nanobanana generate_image {
  "prompt": "A cute banana character wearing sunglasses",
  "aspectRatio": "1:1",
  "imageSize": "1K",
  "outputPath": "/path/to/output/banana.png"
}
```

### Generate with Style Reference

```
@nanobanana generate_image {
  "prompt": "Create a hero image for a tech startup",
  "referenceImagePath": "/path/to/style-ref.png",
  "aspectRatio": "16:9",
  "imageSize": "2K",
  "outputPath": "/path/to/output/hero.png"
}
```

### Natural Language Prompts

```
Generate an image of a futuristic city at night in 16:9 format
Create a logo inspired by my reference image
Upload my test image and show me the file URI
```

## 🎯 How It Works

1. **File Upload Flow**:
   - When you provide a `referenceImagePath`, the server automatically uploads it to Google Files API
   - The upload returns a `fileUri` (e.g., `files/abc123`)
   - This URI is included in the image generation request

2. **Image Generation**:
   - Sends your prompt + optional reference to Gemini Pro Image
   - Receives base64-encoded image data
   - Optionally saves to disk if `outputPath` provided

3. **Authentication**:
   - Uses your API key for all requests
   - Both Files API and Gemini API use the same key
   - No OAuth setup needed!

## 🔒 Security Notes

- **Never commit your API key** - It's in `.gitignore`
- **Regenerate keys** if exposed in chat/logs
- **Files API scope** - Uploaded files are tied to your project
- **File expiration** - Uploaded files have TTL (shown in response)

## 📊 API Limits

- **Free tier**: 15 requests per minute
- **File size**: Up to 20MB per file
- **Supported formats**: JPEG, PNG, GIF, WebP, BMP

## 🆘 Troubleshooting

**Error: "API key not found"**
- Check `.env` file exists and has correct key
- Restart Cursor after updating `mcp.json`

**Error: "File upload failed"**
- Verify file path is absolute
- Check file format is supported
- Ensure file size is under 20MB

**Error: "Invalid API key"**
- Regenerate key at [AI Studio](https://aistudio.google.com/app/apikey)
- Update both `.env` and `mcp.json`

**Image generation is slow**
- Larger sizes (`2K`, `4K`) take longer
- Style reference adds processing time
- First request may be slower (cold start)

## 📚 Resources

- [Google AI Studio](https://aistudio.google.com/)
- [Gemini API Docs](https://ai.google.dev/gemini-api/docs)
- [Files API Guide](https://ai.google.dev/gemini-api/docs/files)
- [Image Generation Cookbook](https://github.com/google-gemini/cookbook)

## 🎉 Next Steps

After testing upload:
- Try generating simple images
- Experiment with style references
- Adjust aspect ratios and sizes
- Integrate into your workflow!

---

**Open source AI image generation MCP**


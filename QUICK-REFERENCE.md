# 🍌 Nanobanana MCP - Quick Reference

## 🚀 One-Minute Setup

```bash
cd nanobanana-mcp
npm install
npm run build
echo "GEMINI_API_KEY=your_key_here" > .env
```

Add to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "nanobanana": {
      "command": "node",
      "args": ["C:\\Users\\woute\\Githubs\\MCP\\nanobanana-mcp\\dist\\index.js"],
      "env": { "GEMINI_API_KEY": "your_key" }
    }
  }
}
```

Restart Cursor. Done! ✅

---

## 💬 Common Commands

### Simple Generation

```
Generate a modern tech logo in 1:1 format and save to Pictures folder
```

### With Style Reference (Token-Efficient!)

```
Create a business card using this style: C:\Users\woute\Pictures\style.png
```

### Multiple References

```
Generate a hero banner combining styles from image1.png and image2.png
```

### Image Editing

```
Edit photo.jpg and replace the background with a beach scene
```

---

## 📋 Tool Quick Reference

### generate_image

**Most Common Use:**

```json
{
  "prompt": "description",
  "referenceImages": [{"source": "url", "url": "https://..."}],
  "aspectRatio": "16:9",
  "imageSize": "1K",
  "outputPath": "C:\\output.png"
}
```

**Key Options:**
- Models: `nano-banana-pro-preview`, `gemini-2.5-flash-image`, `gemini-3-pro-image-preview`
- Ratios: `1:1`, `16:9`, `9:16`, `3:4`, `4:3`
- Sizes: `512x512`, `1K`, `2K`, `4K`

### edit_image

```json
{
  "prompt": "edit instructions",
  "inputImage": {"source": "file_path", "filePath": "..."},
  "outputPath": "C:\\edited.png"
}
```

### upload_image (for reuse)

```json
{
  "source": "file_path",
  "filePath": "C:\\ref.png"
}
```

Returns `fileUri` valid for 48 hours!

---

## 🎯 Token Efficiency Tips

### ✅ DO THIS (Token-Efficient)

```json
{
  "referenceImages": [
    {"source": "url", "url": "https://..."}
  ]
}
```

**Cost:** ~10 tokens

### ⚠️ AVOID THIS (Token-Heavy)

```json
{
  "referenceImages": [
    {"source": "inline", "base64": "iVBORw0KGgoAAAA..."}
  ]
}
```

**Cost:** ~1,500 tokens

### 🚀 BEST FOR REPEATED USE

```json
// Step 1: Upload once
upload_image {"source": "file_path", "filePath": "..."}
// Returns: files/abc123

// Step 2: Reuse many times (48 hours)
{
  "referenceImages": [
    {"source": "file_uri", "fileUri": "files/abc123"}
  ]
}
```

**Cost:** ~10 tokens per use, zero upload!

---

## 🔧 Troubleshooting

### "API key not found"

```bash
echo "GEMINI_API_KEY=your_key" > .env
```

### "Server not starting"

1. Check `.env` exists
2. Verify API key is valid
3. Restart Cursor
4. Check `~/.cursor/mcp.json` path is correct

### "File upload failed"

- Use absolute paths: `C:\Users\...`
- Check file exists
- Max 20MB per file
- Supported: JPG, PNG, GIF, WebP

### "Generation slow"

- Use `1K` instead of `4K`
- Try `gemini-2.5-flash-image` for speed
- Check internet connection

---

## 📊 Quick Metrics

| Feature | Value |
|---------|-------|
| Upload speed | < 1s (100KB) |
| Generation | 5-8s (1K) |
| Token savings | 97%+ vs base64 |
| Cache validity | 48 hours |
| Max file size | 20 MB |
| Models | 3 available |

---

## 🎨 Example Prompts

```
Generate a minimalist tech startup logo with geometric shapes
Create a professional business card with clean typography
Make a social media banner in a vibrant, modern style
Design a product mockup with realistic lighting
Create an app icon with rounded corners and gradient
Generate a hero image for a landing page
Make a poster with bold typography and high contrast
```

---

## 🔗 Resources

- API Key: https://aistudio.google.com/app/apikey
- Full Docs: `README-COMPREHENSIVE.md`
- Implementation: `IMPLEMENTATION-SUMMARY.md`

---

**Quick Start → Full Docs → Build Amazing Images! 🎨**


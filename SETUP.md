# 🚀 Quick Setup & Test Guide

## Step 1: Create `.env` file

```bash
cd C:\Users\woute\Githubs\MCP\nanobanana-mcp
copy environment.template .env
```

Then edit `.env` and add your API key:

```env
GEMINI_API_KEY=your_regenerated_api_key_here
DEBUG=true
```

## Step 2: Get a Test Image

Put any image in the folder, for example:
- `test-image.jpg`
- `test-image.png`

Or use any existing image on your computer.

## Step 3: Quick Upload Test

Run the standalone test script:

```bash
# Using environment variable
node test-upload.js test-image.jpg

# Or pass API key directly
node test-upload.js test-image.jpg YOUR_API_KEY
```

This will:
1. Upload the image to Google Files API
2. Show you the file URI
3. Confirm the upload worked

## Step 4: Test via MCP

### A. Add to Cursor Config

Edit `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "nanobanana": {
      "command": "node",
      "args": ["C:\\Users\\woute\\Githubs\\MCP\\nanobanana-mcp\\dist\\index.js"],
      "env": {
        "GEMINI_API_KEY": "your_api_key_here"
      }
    }
  }
}
```

### B. Restart Cursor

Close and reopen Cursor for MCP changes to take effect.

### C. Test in Cursor

Try these commands:

```
@nanobanana upload_test_image {"filePath": "C:\\Users\\woute\\Githubs\\MCP\\nanobanana-mcp\\test-image.jpg"}
```

## Step 5: Generate Your First Image

```
@nanobanana generate_image {
  "prompt": "A cute banana character wearing sunglasses",
  "aspectRatio": "1:1",
  "imageSize": "1K",
  "outputPath": "C:\\Users\\woute\\Pictures\\banana.png"
}
```

## Troubleshooting

### "GEMINI_API_KEY not found"
- Make sure you created `.env` file
- Check the API key is correct
- Restart the server/Cursor

### "File not found"
- Use absolute paths (full paths with C:\\ etc.)
- Check file actually exists
- Use double backslashes in JSON: `\\`

### "API key invalid"
- Regenerate key at https://aistudio.google.com/app/apikey
- Update both `.env` and `mcp.json`

### "Upload failed: 403"
- API key might be expired/invalid
- Check you have access to Gemini API
- Verify you're not over quota

## Next Steps

✅ Upload test works  
✅ MCP server connected  
🎨 Start generating images!

---

**Need help?** Check the main README.md for more examples.


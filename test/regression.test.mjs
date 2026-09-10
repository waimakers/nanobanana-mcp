import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_IMAGE_SIZE,
  DEFAULT_MODEL,
  extractImage,
  getRuntimeDefaults,
  resolveModel,
  validateImageRequest,
} from "../dist/gemini-client.js";

test("preserves the default and the historical Pro-preview alias", () => {
  assert.equal(DEFAULT_MODEL, "gemini-3-pro-image-preview");
  assert.equal(DEFAULT_IMAGE_SIZE, "2K");
  assert.equal(
    resolveModel("nano-banana-pro-preview"),
    "gemini-3-pro-image-preview",
  );
  assert.deepEqual(getRuntimeDefaults({}), {
    model: DEFAULT_MODEL,
    imageSize: DEFAULT_IMAGE_SIZE,
  });
});

test("rejects prototype names and model-specific unsupported sizes", () => {
  assert.throws(() => resolveModel("__proto__"), /Unsupported model/);
  assert.throws(() => resolveModel("toString"), /Unsupported model/);
  assert.throws(
    () =>
      validateImageRequest(
        {
          prompt: "x",
          model: "gemini-3.1-flash-lite-image",
          imageSize: "2K",
        },
        getRuntimeDefaults({}),
      ),
    /not supported/,
  );
});

test("uses a configured Flash/1K default and skips thought parts", () => {
  assert.deepEqual(
    validateImageRequest(
      { prompt: "x" },
      getRuntimeDefaults({
        NANOBANANA_DEFAULT_MODEL: "gemini-3.1-flash-image",
        NANOBANANA_DEFAULT_IMAGE_SIZE: "1K",
      }),
    ),
    { model: "gemini-3.1-flash-image", imageSize: "1K", aspectRatio: "16:9" },
  );
  assert.deepEqual(
    extractImage({
      candidates: [
        {
          content: {
            parts: [
              {
                thought: true,
                inlineData: { mimeType: "image/png", data: "old" },
              },
              { inlineData: { mimeType: "image/png", data: "AQ==" } },
            ],
          },
        },
      ],
    }),
    { mimeType: "image/png", data: "AQ==" },
  );
});

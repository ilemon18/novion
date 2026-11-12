import { describe, expect, it } from "vitest";
import { relativizeContent } from "./doc-content";

const docWith = (src: string) => ({
  type: "doc",
  content: [{ type: "image", attrs: { src, width: 100, caption: "" } }],
});

const srcOf = (content: unknown) =>
  ((content as { content: { attrs: { src: string } }[] }).content[0].attrs.src);

describe("relativizeContent", () => {
  it("rewrites a macOS asset URL back to the portable form", () => {
    const next = relativizeContent(
      docWith("asset://localhost/Users/me/Documents/Novion/assets/x.png"),
      "/Users/me/Documents/Novion",
    );
    expect(srcOf(next)).toBe("assets/x.png");
  });

  it("drops a percent-encoded Windows asset URL", () => {
    // What `convertFileSrc` produces for C:\Users\me\Documents\Novion\assets\x.png
    const next = relativizeContent(
      docWith(
        "http://asset.localhost/C%3A%5CUsers%5Cme%5CDocuments%5CNovion%5Cassets%5Cx.png",
      ),
      "C:\\Users\\me\\Documents\\Novion",
    );
    expect(srcOf(next)).toBe("assets/x.png");
  });

  it("leaves images outside the workspace alone", () => {
    const remote = "https://example.com/x.png";
    expect(srcOf(relativizeContent(docWith(remote), "/Users/me/Documents/Novion"))).toBe(
      remote,
    );
    const elsewhere = relativizeContent(
      docWith("asset://localhost/Users/me/other/assets/x.png"),
      "/Users/me/Documents/Novion",
    );
    expect(srcOf(elsewhere)).toBe("asset://localhost/Users/me/other/assets/x.png");
  });
});
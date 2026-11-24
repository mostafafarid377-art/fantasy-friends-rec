// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { Avatar } from "@/components/ui";

afterEach(() => { cleanup(); });

// The Avatar component is the sink for a stored avatar_url. Even if a
// javascript:, data: or vbscript: value is already in the database, the
// component must render the initials fallback, never the URL. Real images
// (https, http, same-origin relative, and blob: photo previews) still render.
it("renders a real https avatar URL", () => {
  const view = render(<Avatar name="Mo Salah" url="https://lh3.googleusercontent.com/a/photo" />);
  const img = view.container.querySelector("img");
  expect(img?.getAttribute("src")).toBe("https://lh3.googleusercontent.com/a/photo");
});

it("renders a same-origin relative photo URL (stored player photo)", () => {
  const view = render(<Avatar name="Mo Salah" url="/api/leagues/l/players/p/photo?v=1" />);
  expect(view.container.querySelector("img")?.getAttribute("src")).toBe("/api/leagues/l/players/p/photo?v=1");
});

it("renders a blob: URL (local photo preview before upload)", () => {
  const view = render(<Avatar name="Mo Salah" url="blob:photo-preview" />);
  expect(view.container.querySelector("img")?.getAttribute("src")).toBe("blob:photo-preview");
});

it("never renders a javascript: URL as an img src", () => {
  const view = render(<Avatar name="Mo Salah" url={"javascript:alert(1)"} />);
  expect(view.container.querySelector("img")).toBeNull();
});

it("never renders a data: URL as an img src", () => {
  const view = render(<Avatar name="Mo Salah" url="data:image/svg+xml,<svg onload=alert(1)>" />);
  expect(view.container.querySelector("img")).toBeNull();
});

it("never renders a vbscript: URL as an img src", () => {
  const view = render(<Avatar name="Mo Salah" url="vbscript:msgbox(1)" />);
  expect(view.container.querySelector("img")).toBeNull();
});

it("falls back to initials for a script-capable or missing URL", () => {
  const { container: c1 } = render(<Avatar name="Mo Salah" url={"javascript:alert(1)"} />);
  expect(c1.textContent).toBe("MS");
  const { container: c2 } = render(<Avatar name="Mo Salah" url={null} />);
  expect(c2.textContent).toBe("MS");
});

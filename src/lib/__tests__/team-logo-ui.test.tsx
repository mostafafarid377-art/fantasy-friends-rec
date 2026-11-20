// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { PlayerPhotoField, KEEP_PHOTO, type PhotoChange } from "@/components/PlayerPhotoField";
import { TeamLogo } from "@/components/TeamLogo";

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it("previews an optimized replacement and lets the user remove or undo it", async () => {
  const OriginalURL = URL;
  let blobs = 0;
  vi.stubGlobal("URL", class extends OriginalURL { static createObjectURL() { return `blob:logo-${++blobs}`; } static revokeObjectURL() {} });
  vi.stubGlobal("Image", class { naturalWidth = 128; naturalHeight = 96; decode() { return Promise.resolve(); } });
  vi.spyOn(HTMLCanvasElement.prototype,"getContext").mockImplementation(() => ({ drawImage: vi.fn() } as any));
  vi.spyOn(HTMLCanvasElement.prototype,"toBlob").mockImplementation((callback) => callback(new Blob(["mock"],{type:"image/webp"})));
  function Editor() {
    const [change,setChange] = useState<PhotoChange>(KEEP_PHOTO);
    return <PlayerPhotoField logo name="Reds" current="/saved.webp" change={change} onChange={setChange} onPreparing={vi.fn()} disabled={false} />;
  }
  const view = render(<Editor />);
  expect(view.container.querySelector("img")?.getAttribute("src")).toBe("/saved.webp");
  fireEvent.change(screen.getByLabelText("Replace from gallery"),{target:{files:[new File(["bytes"],"logo.png",{type:"image/png"})]}});
  await waitFor(() => expect(view.container.querySelector("img")?.getAttribute("src")).toMatch(/^blob:logo-/));
  fireEvent.click(screen.getByRole("button",{name:"Remove logo"}));
  expect(view.container.querySelector("img")).toBeNull();
  fireEvent.click(screen.getByRole("button",{name:"Undo logo change"}));
  expect(view.container.querySelector("img")?.getAttribute("src")).toBe("/saved.webp");
  expect(screen.getByLabelText("Take photo").getAttribute("capture")).toBe("environment");
});
it("shows a placeholder when the image is missing or fails to load", () => {
  const {container,rerender} = render(<TeamLogo url="/missing.webp" />);
  fireEvent.error(container.querySelector("img")!);
  expect(container.querySelector("img")).toBeNull();
  expect(container.querySelector("svg")).toBeTruthy();
  rerender(<TeamLogo />);
  expect(container.querySelector("svg")).toBeTruthy();
});

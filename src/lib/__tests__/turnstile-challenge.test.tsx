// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TurnstileChallenge } from "@/components/TurnstileChallenge";

// Client-side Turnstile behavior: the widget renders only when a site key is
// configured, reports tokens up to the parent, clears them on expiration or
// error, and resets the challenge when the parent bumps resetKey (a consumed
// token after a failed submit). The Cloudflare script itself is stubbed.

type Callbacks = {
  sitekey: string;
  callback: (token: string) => void;
  "expired-callback"?: () => void;
  "error-callback"?: () => void;
};

function stubTurnstile() {
  const rendered: Callbacks[] = [];
  const resets: string[] = [];
  const removed: string[] = [];
  const turnstile = {
    render: vi.fn((container: HTMLElement, options: Callbacks) => {
      rendered.push(options);
      container.dataset.widget = `w-${rendered.length}`;
      return `w-${rendered.length}`;
    }),
    reset: vi.fn((id: string) => { resets.push(id); }),
    remove: vi.fn((id: string) => { removed.push(id); }),
  };
  window.turnstile = turnstile;
  return { rendered, resets, removed, turnstile };
}

async function waitForRender() {
  await waitFor(() => expect(window.turnstile!.render).toHaveBeenCalled());
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "test-site-key");
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  delete window.turnstile;
});

describe("TurnstileChallenge", () => {
  it("renders nothing when no site key is configured", () => {
    vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "");
    const { container } = render(<TurnstileChallenge onToken={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders the challenge with the configured site key", async () => {
    const { rendered } = stubTurnstile();
    render(<TurnstileChallenge onToken={vi.fn()} />);
    await waitForRender();
    expect(rendered[0].sitekey).toBe("test-site-key");
  });

  it("reports a solved challenge token to the parent", async () => {
    const { rendered } = stubTurnstile();
    const onToken = vi.fn();
    render(<TurnstileChallenge onToken={onToken} />);
    await waitForRender();
    rendered[0].callback("cf-token-abc");
    expect(onToken).toHaveBeenCalledWith("cf-token-abc");
  });

  it("clears the token and resets the widget when the token expires", async () => {
    const { rendered, resets, turnstile } = stubTurnstile();
    const onToken = vi.fn();
    render(<TurnstileChallenge onToken={onToken} />);
    await waitForRender();
    rendered[0].callback("cf-token-abc");
    rendered[0]["expired-callback"]?.();
    expect(onToken).toHaveBeenLastCalledWith(null);
    expect(turnstile.reset).toHaveBeenCalledWith(resets[0]);
  });

  it("clears the token and shows an error when verification fails", async () => {
    const { rendered } = stubTurnstile();
    const onToken = vi.fn();
    render(<TurnstileChallenge onToken={onToken} />);
    await waitForRender();
    rendered[0].callback("cf-token-abc");
    rendered[0]["error-callback"]?.();
    expect(onToken).toHaveBeenLastCalledWith(null);
    expect((await screen.findByRole("alert")).textContent).toMatch(/could not start/i);
  });

  it("clears the token and resets the challenge when resetKey changes", async () => {
    const { resets } = stubTurnstile();
    const onToken = vi.fn();
    const { rerender } = render(<TurnstileChallenge onToken={onToken} resetKey={0} />);
    await waitForRender();
    onToken.mockClear();
    rerender(<TurnstileChallenge onToken={onToken} resetKey={1} />);
    expect(onToken).toHaveBeenCalledWith(null);
    expect(resets).toHaveLength(1);
  });

  it("ignores the initial resetKey mount (no spurious reset)", async () => {
    const { resets } = stubTurnstile();
    render(<TurnstileChallenge onToken={vi.fn()} resetKey={0} />);
    await waitForRender();
    expect(resets).toHaveLength(0);
  });

  it("removes the widget on unmount", async () => {
    const { removed } = stubTurnstile();
    const { unmount } = render(<TurnstileChallenge onToken={vi.fn()} />);
    await waitForRender();
    unmount();
    expect(removed).toEqual(["w-1"]);
  });

  it("surfaces a load failure when the script errors", async () => {
    const onToken = vi.fn();
    render(<TurnstileChallenge onToken={onToken} />);
    await waitFor(() => expect(document.head.querySelector("script")).not.toBeNull());
    fireEvent.error(document.head.querySelector("script")!);
    expect((await screen.findByRole("alert")).textContent).toMatch(/could not start/i);
    expect(onToken).toHaveBeenCalledWith(null);
  });
});

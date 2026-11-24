// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// End-to-end form behavior for Turnstile across login, signup, and forgot
// password: gating while unverified, token forwarding, consumed-token reset
// after a failed submit, expiration clearing, and no-CAPTCHA behavior when no
// site key is configured. The Cloudflare script and the network layer (api)
// are mocked; next/navigation is stubbed as in google-auth-pages.test.tsx.

import LoginForm from "@/app/(auth)/login/LoginForm";
import SignupForm from "@/app/(auth)/signup/SignupForm";
import ForgotPage from "@/app/(auth)/forgot/page";
import { api, ApiRequestError } from "@/lib/client/api";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/lib/client/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client/api")>();
  return { ...actual, api: vi.fn() };
});
const apiMock = vi.mocked(api);

type Callbacks = {
  callback: (token: string) => void;
  "expired-callback"?: () => void;
  "error-callback"?: () => void;
};

function stubTurnstile() {
  const rendered: Callbacks[] = [];
  const resets: string[] = [];
  window.turnstile = {
    render: vi.fn((container: HTMLElement, options: Callbacks & { sitekey: string }) => {
      rendered.push(options);
      return `w-${rendered.length}`;
    }),
    reset: vi.fn((id: string) => { resets.push(id); }),
    remove: vi.fn(),
  };
  return { rendered, resets };
}

async function waitForChallenge() {
  await waitFor(() => expect(window.turnstile!.render).toHaveBeenCalled());
}

function solve(t: ReturnType<typeof stubTurnstile>, token: string) {
  act(() => { t.rendered[0].callback(token); });
}
function expire(t: ReturnType<typeof stubTurnstile>) {
  act(() => { t.rendered[0]["expired-callback"]?.(); });
}

const loginSubmit = () => screen.getByRole("button", { name: /^sign in$/i }) as HTMLButtonElement;
const signupSubmit = () => screen.getByRole("button", { name: /create account/i }) as HTMLButtonElement;
const forgotSubmit = () => screen.getByRole("button", { name: /send reset link/i }) as HTMLButtonElement;

function fillLogin() {
  fireEvent.change(screen.getByLabelText(/email/i), { target: { value: "mo@example.com" } });
  fireEvent.change(screen.getByLabelText(/password/i), { target: { value: "hunter2pass" } });
}
function fillSignup() {
  fireEvent.change(screen.getByLabelText(/display name/i), { target: { value: "Mo Salah" } });
  fireEvent.change(screen.getByLabelText(/username/i), { target: { value: "mosalah" } });
  fireEvent.change(screen.getByLabelText(/^email/i), { target: { value: "mo@example.com" } });
  fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: "hunter2pass" } });
  fireEvent.change(screen.getByLabelText(/confirm/i), { target: { value: "hunter2pass" } });
}
function fillForgot() {
  fireEvent.change(screen.getByLabelText(/email/i), { target: { value: "mo@example.com" } });
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "test-site-key");
  apiMock.mockReset();
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  delete window.turnstile;
});

describe("login form", () => {
  it("blocks submit until the challenge is solved, then sends the token", async () => {
    const t = stubTurnstile();
    apiMock.mockResolvedValue({ user: { id: "u1" } });
    render(<LoginForm next="/dashboard" googleStartToken={null} authError={undefined} />);
    await waitForChallenge();

    expect(loginSubmit().disabled).toBe(true);
    fillLogin();
    expect(loginSubmit().disabled).toBe(true); // still unverified
    solve(t, "cf-token-1");
    expect(loginSubmit().disabled).toBe(false);
    fireEvent.click(loginSubmit());
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith("/api/auth/login", {
      method: "POST",
      body: { email: "mo@example.com", password: "hunter2pass", captchaToken: "cf-token-1" },
    }));
  });

  it("resets the challenge and shows the server error after a failed attempt", async () => {
    const t = stubTurnstile();
    apiMock.mockRejectedValue(new ApiRequestError("Incorrect email or password", 401));
    render(<LoginForm next="/dashboard" googleStartToken={null} authError={undefined} />);
    await waitForChallenge();
    solve(t, "cf-token-1");
    fillLogin();
    fireEvent.click(loginSubmit());
    expect((await screen.findByRole("alert")).textContent).toMatch(/incorrect email or password/i);
    // Consumed token: cleared, challenge reset, submit gated again.
    await waitFor(() => expect(t.resets).toHaveLength(1));
    expect(loginSubmit().disabled).toBe(true);
    // Solving the fresh challenge re-enables submit.
    solve(t, "cf-token-2");
    expect(loginSubmit().disabled).toBe(false);
  });

  it("gates again when the token expires before submit", async () => {
    const t = stubTurnstile();
    render(<LoginForm next="/dashboard" googleStartToken={null} authError={undefined} />);
    await waitForChallenge();
    solve(t, "cf-token-1");
    expect(loginSubmit().disabled).toBe(false);
    expire(t);
    expect(loginSubmit().disabled).toBe(true);
  });

  it("submits without a token when no site key is configured", async () => {
    vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "");
    apiMock.mockResolvedValue({ user: { id: "u1" } });
    render(<LoginForm next="/dashboard" googleStartToken={null} authError={undefined} />);
    expect(screen.queryByLabelText(/human verification/i)).toBeNull();
    fillLogin();
    expect(loginSubmit().disabled).toBe(false);
    fireEvent.click(loginSubmit());
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith("/api/auth/login", {
      method: "POST",
      body: { email: "mo@example.com", password: "hunter2pass" },
    }));
  });
});

describe("signup form", () => {
  it("blocks submit until verified, then forwards the token", async () => {
    const t = stubTurnstile();
    apiMock.mockResolvedValue({ requiresEmailVerification: true });
    render(<SignupForm next="/dashboard" googleStartToken={null} />);
    await waitForChallenge();
    expect(signupSubmit().disabled).toBe(true);
    fillSignup();
    solve(t, "cf-token-signup");
    expect(signupSubmit().disabled).toBe(false);
    fireEvent.click(signupSubmit());
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith("/api/auth/signup", {
      method: "POST",
      body: expect.objectContaining({ email: "mo@example.com", captchaToken: "cf-token-signup" }),
    }));
  });

  it("resets the challenge after a rejected signup", async () => {
    const t = stubTurnstile();
    apiMock.mockRejectedValue(new ApiRequestError("An account with that email already exists", 409));
    render(<SignupForm next="/dashboard" googleStartToken={null} />);
    await waitForChallenge();
    solve(t, "cf-token-signup");
    fillSignup();
    fireEvent.click(signupSubmit());
    await screen.findByText(/already exists/i);
    await waitFor(() => expect(t.resets).toHaveLength(1));
    expect(signupSubmit().disabled).toBe(true);
  });
});

describe("forgot-password form", () => {
  it("blocks submit until verified, forwards the token, and resets on failure", async () => {
    const t = stubTurnstile();
    apiMock.mockRejectedValueOnce(new ApiRequestError("Could not send the reset email. Try again later.", 400));
    render(<ForgotPage />);
    await waitForChallenge();
    expect(forgotSubmit().disabled).toBe(true);
    fillForgot();
    solve(t, "cf-token-forgot");
    expect(forgotSubmit().disabled).toBe(false);
    fireEvent.click(forgotSubmit());
    await screen.findByText(/could not send/i);
    expect(apiMock).toHaveBeenCalledWith("/api/auth/forgot", {
      method: "POST",
      body: { email: "mo@example.com", captchaToken: "cf-token-forgot" },
    });
    await waitFor(() => expect(t.resets).toHaveLength(1));
    expect(forgotSubmit().disabled).toBe(true);
  });

  it("requires a fresh challenge after a successful send (Send again)", async () => {
    const t = stubTurnstile();
    apiMock.mockResolvedValue({ ok: true });
    render(<ForgotPage />);
    await waitForChallenge();
    fillForgot();
    solve(t, "cf-token-forgot");
    fireEvent.click(forgotSubmit());
    await screen.findByText(/check your inbox/i);
    fireEvent.click(screen.getByRole("button", { name: /send again/i }));
    // Back on the form: the consumed token is gone and the user must verify
    // again before resubmitting.
    expect(forgotSubmit().disabled).toBe(true);
  });

  it("submits without a token when no site key is configured", async () => {
    vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "");
    apiMock.mockResolvedValue({ ok: true });
    render(<ForgotPage />);
    fillForgot();
    fireEvent.click(forgotSubmit());
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith("/api/auth/forgot", {
      method: "POST",
      body: { email: "mo@example.com" },
    }));
  });
});

// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Regression coverage for the credential-in-URL incident found by the E2E
// journeys (J04 observed the browser at /login?email=…&password=…).
//
// Root cause: a development CSP without 'unsafe-eval' blocked the dev
// bundler's eval()-executed chunks, React never hydrated, and the forms —
// which declared no method — fell back to NATIVE GET submission, serializing
// credentials into the URL (and from there into browser history, referer
// headers and server logs).
//
// These tests pin the two layers of defence:
//   1. Hydrated path: React's submit handler runs and calls preventDefault,
//      so the browser never performs a native navigation; the request leaves
//      as a POST fetch to a query-string-free API route, and client-side
//      navigation carries no credentials.
//   2. Dead-JS fallback: every credential form declares method="post", so
//      even a native submission can never serialize fields into the URL.
//
// The network layer (api) and next/navigation are mocked exactly as in
// turnstile-forms.test.tsx; no Turnstile site key is set, so no CAPTCHA
// challenge gates the forms here.

import LoginForm from "@/app/(auth)/login/LoginForm";
import SignupForm from "@/app/(auth)/signup/SignupForm";
import ForgotPage from "@/app/(auth)/forgot/page";
import ResetPage from "@/app/(auth)/reset/page";
import { api, ApiRequestError } from "@/lib/client/api";

const pushMock = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: pushMock, refresh: vi.fn(), replace: vi.fn() }) }));
vi.mock("@/lib/client/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client/api")>();
  return { ...actual, api: vi.fn() };
});
const apiMock = vi.mocked(api);

const PASSWORD = "Sup3r-Secret-Passphrase!";

function onlyForm(container: HTMLElement): HTMLFormElement {
  const forms = container.querySelectorAll("form");
  expect(forms).toHaveLength(1);
  return forms[0] as HTMLFormElement;
}

/** The submit event must be cancelled by the React handler — dispatchEvent
 *  returns false only when preventDefault ran, i.e. no native navigation. */
function expectSubmitPrevented(form: HTMLFormElement) {
  const notCancelled = fireEvent.submit(form);
  expect(notCancelled).toBe(false);
}

/** No observable URL may ever contain credential material. */
function expectNoCredentialInUrls(secret: string) {
  expect(window.location.href).not.toContain(secret);
  expect(decodeURIComponent(window.location.href)).not.toContain(secret);
  for (const call of pushMock.mock.calls) {
    expect(String(call[0])).not.toContain(secret);
  }
  for (const call of apiMock.mock.calls) {
    const route = String(call[0]);
    expect(route).not.toContain("?");
    expect(decodeURIComponent(route)).not.toContain(secret);
  }
}

beforeEach(() => {
  apiMock.mockReset();
  pushMock.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("auth forms never leak credentials into URLs (native fallback)", () => {
  it.each([
    ["login", () => render(<LoginForm next="/dashboard" googleStartToken={null} />)],
    ["signup", () => render(<SignupForm next="/dashboard" googleStartToken={null} />)],
    ["forgot", () => render(<ForgotPage />)],
    ["reset", () => render(<ResetPage />)],
  ] as const)("%s: the form's native fallback is POST, never GET", (_name, renderForm) => {
    const { container } = renderForm();
    const form = onlyForm(container);
    // With no method attribute the native fallback is GET, which serializes
    // every named field into the query string. method="post" keeps the
    // fallback payload in the request body instead.
    expect(form.method).toBe("post");
    // And there must be no explicit action pointing anywhere but the page
    // itself (a cross-origin action would receive the POST body).
    const action = form.getAttribute("action");
    expect(action === null || action === "" || action.startsWith("/")).toBe(true);
  });
});

describe("auth forms submit via prevented-default POST fetch (hydrated path)", () => {
  it("login: submit is prevented, POSTs /api/auth/login, navigates credential-free", async () => {
    apiMock.mockResolvedValue({ user: { id: "u1" } });
    const { container } = render(<LoginForm next="/dashboard" googleStartToken={null} />);
    const form = onlyForm(container);

    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "user@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: PASSWORD } });
    expectSubmitPrevented(form);

    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(1));
    expect(apiMock.mock.calls[0][0]).toBe("/api/auth/login");
    expect(apiMock.mock.calls[0][1]?.method).toBe("POST");
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/dashboard"));
    expectNoCredentialInUrls(PASSWORD);
  });

  it("signup: submit is prevented, POSTs /api/auth/signup, shows the confirmation step without navigating", async () => {
    apiMock.mockResolvedValue({ requiresEmailVerification: true, user: { id: "u2" } });
    const { container } = render(<SignupForm next="/dashboard" googleStartToken={null} />);
    const form = onlyForm(container);

    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Regression Tester" } });
    fireEvent.change(screen.getByLabelText(/^Username/), { target: { value: "regression_tester" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "regression@example.com" } });
    fireEvent.change(screen.getByLabelText("Password", { exact: true }), { target: { value: PASSWORD } });
    fireEvent.change(screen.getByLabelText("Confirm"), { target: { value: PASSWORD } });
    expectSubmitPrevented(form);

    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(1));
    expect(apiMock.mock.calls[0][0]).toBe("/api/auth/signup");
    expect(apiMock.mock.calls[0][1]?.method).toBe("POST");
    await screen.findByRole("heading", { name: "Check your email" });
    expect(pushMock).not.toHaveBeenCalled();
    expectNoCredentialInUrls(PASSWORD);
  });

  it("forgot: submit is prevented, POSTs /api/auth/forgot, shows the confirmation step", async () => {
    apiMock.mockResolvedValue({});
    const { container } = render(<ForgotPage />);
    const form = onlyForm(container);

    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "user@example.com" } });
    expectSubmitPrevented(form);

    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(1));
    expect(apiMock.mock.calls[0][0]).toBe("/api/auth/forgot");
    expect(apiMock.mock.calls[0][1]?.method).toBe("POST");
    await screen.findByRole("heading", { name: "Check your inbox" });
    expectNoCredentialInUrls("user@example.com");
  });

  it("reset: submit is prevented, POSTs /api/auth/reset with the password in the body only", async () => {
    apiMock.mockResolvedValue({});
    const { container } = render(<ResetPage />);
    const form = onlyForm(container);

    fireEvent.change(screen.getByLabelText("New password"), { target: { value: PASSWORD } });
    fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: PASSWORD } });
    expectSubmitPrevented(form);

    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(1));
    expect(apiMock.mock.calls[0][0]).toBe("/api/auth/reset");
    expect(apiMock.mock.calls[0][1]?.method).toBe("POST");
    expectNoCredentialInUrls(PASSWORD);
  });
});

describe("auth error contract (non-enumerating, recovery-session enforced)", () => {
  it("login: a wrong password surfaces exactly the generic error and stays put", async () => {
    apiMock.mockRejectedValue(new ApiRequestError("Incorrect email or password", 401));
    render(<LoginForm next="/dashboard" googleStartToken={null} />);

    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "user@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "wrong-password" } });
    fireEvent.click(screen.getByRole("button", { name: /Sign in/ }));

    await screen.findByRole("alert");
    expect(screen.getByRole("alert").textContent).toBe("Incorrect email or password");
    expect(pushMock).not.toHaveBeenCalled();
    expectNoCredentialInUrls("wrong-password");
  });

  it("reset: without a recovery session the API rejection is surfaced as invalid/expired", async () => {
    apiMock.mockRejectedValue(new ApiRequestError("This reset link is invalid or has expired", 401));
    render(<ResetPage />);

    fireEvent.change(screen.getByLabelText("New password"), { target: { value: PASSWORD } });
    fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: PASSWORD } });
    fireEvent.click(screen.getByRole("button", { name: /Set new password/ }));

    await screen.findByText(/invalid or has expired/i);
    expect(pushMock).not.toHaveBeenCalled();
    expectNoCredentialInUrls(PASSWORD);
  });
});

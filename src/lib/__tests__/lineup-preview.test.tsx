// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { LineupPreview } from "@/components/lineup-preview/LineupPreview";
import { changeSampleFormation, FORMATION_OPTIONS, PREVIOUS_SAVED_LINEUP } from "@/components/lineup-preview/sample-lineup";
import { layoutFormation, orderedBench } from "@/lib/domain";

const click = (name: string | RegExp) => fireEvent.click(screen.getByRole("button", { name }));
const pitch = () => within(screen.getByRole("region", { name: /football pitch/ }));
const bench = () => within(screen.getByRole("list", { name: "Bench order" }));
const select = (name: string) => screen.getByRole<HTMLSelectElement>("combobox", { name });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("sample-only Next Match Lineup preview", () => {
  it("swaps a matching player, changes formation and captaincy, reorders the bench and saves only in memory", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const page = render(<LineupPreview />);
    expect(pitch().getByRole("button", { name: "Rami Saad, GK" })).toBeTruthy();
    expect(screen.queryByRole("timer")).toBeNull();
    click("Next Match");
    expect(screen.getByRole("heading", { name: "Next Match Lineup" })).toBeTruthy();
    fireEvent.click(screen.getByText("Previous saved lineup"));
    const historical = document.querySelector('[aria-label="Previous saved starters"]')!;
    const original = historical.textContent;
    expect(original).toContain("Adam Nasser");
    expect(original).not.toContain("Rami Saad");
    expect(select("Captain").value).toBe("zayd");
    expect(select("Vice-captain").value).toBe("omar");
    fireEvent.click(pitch().getByRole("button", { name: /Adam Nasser/ }));
    const picker = within(screen.getByRole("dialog", { name: "Replace Adam Nasser" }));
    expect(picker.queryByText("Karim Fathy")).toBeNull();
    fireEvent.change(picker.getByRole("searchbox"), { target: { value: "Rami" } });
    expect(picker.queryByText("Anas Farouk")).toBeNull();
    fireEvent.click(picker.getByRole("button", { name: /Rami Saad/ }));
    expect(pitch().getByRole("button", { name: "Rami Saad, GK" })).toBeTruthy();
    expect(bench().getByRole("button", { name: "Replace Adam Nasser, bench goalkeeper" })).toBeTruthy();
    fireEvent.change(select("Formation"), { target: { value: "3-2-1" } });
    expect(screen.getByRole("region", { name: /formation 3-2-1/ })).toBeTruthy();
    expect(pitch().getAllByRole("button")).toHaveLength(7);
    fireEvent.change(select("Captain"), { target: { value: "karim" } });
    fireEvent.change(select("Vice-captain"), { target: { value: "malik" } });
    expect(pitch().getByRole("button", { name: "Karim Fathy, DEF, captain" })).toBeTruthy();
    expect(pitch().getByRole("button", { name: "Malik Adel, DEF, vice-captain" })).toBeTruthy();
    expect(within(select("Captain")).getByRole<HTMLOptionElement>("option", { name: "Malik Adel" }).disabled).toBe(true);
    click("Raise Hamza Samir priority");
    expect(bench().getAllByRole("listitem")[1].textContent).toContain("Hamza Samir");
    expect(screen.getByText("Unsaved preview changes")).toBeTruthy();
    click("Save changes");
    expect(screen.getByText(/Saved for this open preview only/)).toBeTruthy();
    expect(screen.getByText("No unsaved changes")).toBeTruthy();
    expect(historical.textContent).toBe(original);

    click("Edit Squad");
    expect(screen.getByRole("heading", { name: "Edit Squad" })).toBeTruthy();
    expect(select("Formation").value).toBe("2-2-2");
    click("Next Match");
    expect(pitch().getByRole("button", { name: "Rami Saad, GK" })).toBeTruthy();
    page.unmount();
    render(<LineupPreview />);
    click("Next Match");
    expect(pitch().getByRole("button", { name: "Adam Nasser, GK" })).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("ticks a sample countdown and only locks when the preview switch is used", () => {
    vi.useFakeTimers();
    render(<LineupPreview />);
    click("Next Match");
    expect(screen.getByRole("timer").textContent).toContain("08Secs");
    act(() => vi.advanceTimersByTime(110_000_000));
    expect(screen.getByRole("timer").textContent).toContain("00Days00Hours00Mins00Secs");
    expect(select("Formation").disabled).toBe(false);
    fireEvent.change(select("Formation"), { target: { value: "2-3-1" } });
    click("After kickoff");
    expect(screen.getByText("Simulated lock.")).toBeTruthy();
    expect(pitch().queryByRole("button")).toBeNull();
    expect(pitch().getAllByRole("img")).toHaveLength(7);
    expect(select("Formation").disabled).toBe(true);
    expect(select("Captain").disabled).toBe(true);
    expect(select("Vice-captain").disabled).toBe(true);
    expect(bench().getAllByRole<HTMLButtonElement>("button", { name: /priority/ }).every((button) => button.disabled)).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Save changes" }).disabled).toBe(true);
    click("Before kickoff");
    expect(select("Formation").value).toBe("2-3-1");
    expect(select("Formation").disabled).toBe(false);
  });

  it("hides Next Match and its draft for a new user even after saving sample squad edits", () => {
    render(<LineupPreview />);
    click("Next Match");
    fireEvent.change(select("Formation"), { target: { value: "3-2-1" } });
    click("New user");
    const views = within(screen.getByRole("group", { name: "My Squad views" }));
    expect(views.getAllByRole("button").map((button) => button.textContent)).toEqual(["Edit Squad"]);
    expect(screen.getByRole("heading", { name: "No previous lineup yet" })).toBeTruthy();
    expect(screen.queryByText("Previous saved lineup")).toBeNull();
    expect(screen.queryByRole("timer")).toBeNull();
    fireEvent.change(select("Formation"), { target: { value: "2-1-3" } });
    click("Save changes");
    expect(views.queryByRole("button", { name: "Next Match" })).toBeNull();
    click("Existing user");
    click("Next Match");
    expect(select("Formation").value).toBe("2-2-2");
    expect(pitch().getByRole("button", { name: "Adam Nasser, GK" })).toBeTruthy();
  });

  it("fills every starting position for all sample formation transitions without duplicating players", () => {
    for (const from of FORMATION_OPTIONS) {
      for (const to of FORMATION_OPTIONS) {
        const draft = changeSampleFormation(changeSampleFormation(PREVIOUS_SAVED_LINEUP, from.label), to.label);
        expect(draft.formation).toBe(to.label);
        expect(layoutFormation(draft.players, to).every((p) => p.playerId !== null)).toBe(true);
        expect(orderedBench(draft.players).map((p) => p.order)).toEqual([0, 1, 2, 3]);
        expect(new Set(draft.players.map((p) => p.id))).toEqual(new Set(PREVIOUS_SAVED_LINEUP.players.map((p) => p.id)));
      }
    }
  });
});

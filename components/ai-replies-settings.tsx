"use client";

import { useEffect, useState } from "react";

const MAX_BRAIN_LENGTH = 6000;

interface AiAccount {
  id: string;
  username: string;
  aiEnabled: boolean;
  aiCommentsEnabled: boolean;
  aiBrain: string | null;
}

function Toggle({
  on,
  label,
  disabled,
  onClick,
}: {
  on: boolean;
  label: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={`relative h-7 w-12 shrink-0 rounded-full transition-colors disabled:opacity-50 ${
        on ? "bg-accent" : "bg-border"
      }`}
    >
      <span
        className={`absolute top-1 h-5 w-5 rounded-full bg-white transition-transform ${
          on ? "translate-x-6" : "translate-x-1"
        }`}
      />
    </button>
  );
}

const BRAIN_PLACEHOLDER = `Who the business is, what it sells, and where enquiries should go. For example:

Mauli Infra builds residential projects in Nagpur.
Sales team: +91 XXXXX XXXXX. Website: mauliinfra.com
Site visits are booked by the sales team, not over DM.
We do not do barter or influencer collaborations.`;

/**
 * Per-account AI reply configuration.
 *
 * Deliberately one brain per Instagram account rather than one per workspace:
 * agencies run several clients from a single install, and a shared brain would
 * let one client's facts answer another client's DMs.
 */
export function AiRepliesSettings() {
  const [accounts, setAccounts] = useState<AiAccount[]>([]);
  const [aiConfigured, setAiConfigured] = useState(true);
  const [loading, setLoading] = useState(true);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/instagram/ai")
      .then((res) => res.json())
      .then((payload) => {
        if (!payload.success) return;
        setAccounts(payload.data.accounts);
        setAiConfigured(payload.data.aiConfigured);
        setDrafts(
          Object.fromEntries(
            payload.data.accounts.map((a: AiAccount) => [a.id, a.aiBrain ?? ""])
          )
        );
      })
      .finally(() => setLoading(false));
  }, []);

  async function patch(
    accountId: string,
    body: { aiEnabled?: boolean; aiCommentsEnabled?: boolean; aiBrain?: string },
    busyKey: string
  ) {
    setBusy(busyKey);
    setErrors((prev) => ({ ...prev, [accountId]: "" }));

    const res = await fetch("/api/instagram/ai", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instagramAccountId: accountId, ...body }),
    });
    const payload = await res.json();

    if (payload.success) {
      setAccounts((prev) =>
        prev.map((a) => (a.id === accountId ? payload.data.account : a))
      );
      setSaved(accountId);
      setTimeout(() => setSaved(null), 3000);
    } else {
      setErrors((prev) => ({ ...prev, [accountId]: payload.error }));
    }
    setBusy(null);
  }

  if (loading) {
    return <section className="panel rounded p-4 sm:p-6 h-48" />;
  }

  return (
    <section className="panel rounded p-4 sm:p-6">
      <h2 className="text-base font-semibold">AI Replies</h2>
      <p className="mt-1 text-xs text-muted">
        Answers in the sender&apos;s own language. It will never state a price,
        size, date or availability — those are handed to a human instead, even
        if you write them below. Comment replies only ever go to comments no
        campaign matched, so keyword campaigns are never intercepted.
      </p>

      {!aiConfigured && (
        <p className="mt-4 rounded border border-warning/20 bg-warning/10 px-3 py-2 text-xs text-warning">
          No <code>GEMINI_API_KEY</code> is set on the worker, so replies will
          not send even when switched on.
        </p>
      )}

      {accounts.length === 0 && (
        <p className="mt-4 text-sm text-muted">
          Connect an Instagram account first.
        </p>
      )}

      <div className="mt-4 space-y-4">
        {accounts.map((account) => {
          const draft = drafts[account.id] ?? "";
          const dirty = draft.trim() !== (account.aiBrain ?? "");
          const tooLong = draft.length > MAX_BRAIN_LENGTH;

          return (
            <div
              key={account.id}
              className="rounded border border-border bg-surface/70 p-4"
            >
              <p className="text-sm font-semibold text-foreground">
                @{account.username}
              </p>

              <div className="mt-3 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-xs font-medium text-foreground">
                      Reply to DMs
                    </p>
                    <p className="mt-0.5 text-xs text-muted">
                      {account.aiEnabled
                        ? "Answering direct messages"
                        : "Off — campaigns handle DMs"}
                    </p>
                  </div>
                  <Toggle
                    on={account.aiEnabled}
                    label={`AI DM replies for @${account.username}`}
                    disabled={busy === `toggle:${account.id}`}
                    onClick={() =>
                      patch(
                        account.id,
                        { aiEnabled: !account.aiEnabled },
                        `toggle:${account.id}`
                      )
                    }
                  />
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
                  <div>
                    <p className="text-xs font-medium text-foreground">
                      Reply to comments{" "}
                      <span className="font-normal text-muted">(public)</span>
                    </p>
                    <p className="mt-0.5 text-xs text-muted">
                      {account.aiCommentsEnabled
                        ? "Replying under posts no campaign covers"
                        : "Off — comments are left alone"}
                    </p>
                  </div>
                  <Toggle
                    on={account.aiCommentsEnabled}
                    label={`AI comment replies for @${account.username}`}
                    disabled={busy === `comments:${account.id}`}
                    onClick={() =>
                      patch(
                        account.id,
                        { aiCommentsEnabled: !account.aiCommentsEnabled },
                        `comments:${account.id}`
                      )
                    }
                  />
                </div>
              </div>

              <label
                htmlFor={`brain-${account.id}`}
                className="mt-4 block text-xs font-medium text-foreground"
              >
                What the AI knows about this client
              </label>
              <textarea
                id={`brain-${account.id}`}
                value={draft}
                rows={8}
                spellCheck={false}
                placeholder={BRAIN_PLACEHOLDER}
                onChange={(event) =>
                  setDrafts((prev) => ({
                    ...prev,
                    [account.id]: event.target.value,
                  }))
                }
                className="mt-2 w-full rounded border border-border bg-surface px-3 py-2 font-mono text-xs leading-relaxed text-foreground outline-none transition-colors focus:border-accent/40"
              />

              <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
                <p
                  className={`tabular text-xs ${tooLong ? "text-error" : "text-muted"}`}
                >
                  {draft.length.toLocaleString()} / {MAX_BRAIN_LENGTH.toLocaleString()}
                </p>

                <div className="flex items-center gap-3">
                  {saved === account.id && (
                    <span className="text-xs text-success" aria-live="polite">
                      Saved
                    </span>
                  )}
                  <button
                    type="button"
                    disabled={!dirty || tooLong || busy === `brain:${account.id}`}
                    onClick={() =>
                      patch(
                        account.id,
                        { aiBrain: draft },
                        `brain:${account.id}`
                      )
                    }
                    className="rounded bg-accent px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-accent-hover disabled:opacity-40"
                  >
                    {busy === `brain:${account.id}` ? "Saving..." : "Save brain"}
                  </button>
                </div>
              </div>

              {errors[account.id] && (
                <p className="mt-2 text-xs text-error" role="alert">
                  {errors[account.id]}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

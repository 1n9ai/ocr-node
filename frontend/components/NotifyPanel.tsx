"use client";

import { useState } from "react";
import { BellRing, Check, ChevronDown, Loader2, Plus, Send, Trash2, User, Users } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { addNotifyRecipient, removeNotifyRecipient, saveSettings, testNotify } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import type { NodeSettings, NotifyRecipient } from "@/lib/types";

/** แจ้งเตือนผ่าน LINE: token ถูกเก็บเข้ารหัสที่ node ไม่ส่งกลับมาหน้าเว็บ (ช่องว่าง = ใช้ค่าที่บันทึกไว้)
 *  ผู้รับเป็นรายการ: เพิ่ม/ลบทีละราย มีผลทันที (ไม่ต้องกดบันทึก) */
export function NotifyPanel({ notify, onSaved }: { notify: NodeSettings["notify"]; onSaved: () => Promise<void> }) {
  const { t, errorText } = useI18n();
  const [enabled, setEnabled] = useState(notify.enabled);
  const [token, setToken] = useState("");
  const [template, setTemplate] = useState(notify.template);
  const [people, setPeople] = useState<NotifyRecipient[]>(notify.recipients);
  const [newId, setNewId] = useState("");
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const defaultTemplate = t("notify.default_template");
  const canTest = !!(token.trim() || notify.api_key.set);

  async function run(key: string, fn: () => Promise<string | void>) {
    setBusy(key);
    setNote(null);
    try {
      const text = await fn();
      if (text) setNote({ ok: true, text });
    } catch (e) {
      setNote({ ok: false, text: errorText(e) });
    } finally {
      setBusy(null);
    }
  }

  const save = () =>
    run("save", async () => {
      await saveSettings({ notify: { enabled, template: template.trim() || defaultTemplate, ...(token.trim() ? { api_key: token.trim() } : {}) } });
      setToken("");
      await onSaved();
      return t("rules.saved");
    });

  const add = () =>
    run("add", async () => {
      const r = await addNotifyRecipient({ id: newId.trim(), name: newName.trim() });
      setPeople(r.recipients);
      setNewId("");
      setNewName("");
    });

  const remove = (rid: string) =>
    run("rm:" + rid, async () => {
      const r = await removeNotifyRecipient(rid);
      setPeople(r.recipients);
    });

  const test = (rid?: string) =>
    run("test:" + (rid ?? "all"), async () => {
      const r = await testNotify({ text: t("notify.test_text"), ...(rid ? { rid } : {}), ...(token.trim() ? { api_key: token.trim() } : {}) });
      return r.failed ? t("notify.test_partial", { sent: r.sent, failed: r.failed }) : t("notify.test_ok");
    });

  return (
    <section className="rounded-2xl bg-white p-5 shadow-float ring-1 ring-accent-200/60 sm:p-6">
      <div className="mb-4 flex items-start gap-3">
        <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-700">
          <BellRing size={18} />
        </span>
        <div>
          <h2 className="text-base font-semibold text-accent-900">{t("notify.title")}</h2>
          <p className="mt-0.5 text-sm text-accent-500">{t("notify.desc")}</p>
        </div>
      </div>
      <details className="group mb-4 rounded-xl bg-accent-50 px-4 py-3 text-sm text-accent-700 ring-1 ring-inset ring-accent-200/60">
        <summary className="flex cursor-pointer list-none items-center justify-between font-medium text-accent-900">
          {t("notify.guide.title")}
          <ChevronDown size={16} className="transition group-open:rotate-180" />
        </summary>
        <ol className="mt-3 list-decimal space-y-1.5 pl-5">
          <li>{t("notify.guide.s1")}</li>
          <li>{t("notify.guide.s2")}</li>
          <li>{t("notify.guide.s3")}</li>
          <li>{t("notify.guide.s4")}</li>
          <li>{t("notify.guide.s5")}</li>
        </ol>
        <p className="mt-3 text-xs text-accent-500">{t("notify.guide.note")}</p>
      </details>

      <div className="grid gap-4 md:grid-cols-2">
        <label className="md:col-span-2 flex items-center gap-2 text-sm text-accent-700">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          {t("notify.enabled")}
        </label>
        <div>
          <label className="field-label">{t("notify.token")}</label>
          <input
            className="field font-mono text-[13px]"
            type="password"
            autoComplete="off"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={notify.api_key.set ? t("common.saved_hint", { hint: notify.api_key.hint }) : ""}
          />
        </div>
        <div>
          <label className="field-label">{t("notify.template")}</label>
          <input className="field" value={template} onChange={(e) => setTemplate(e.target.value)} placeholder={defaultTemplate} />
          <p className="mt-1 text-xs text-accent-400">{t("notify.template_hint")}</p>
        </div>
      </div>

      <div className="mt-5">
        <label className="field-label">{t("notify.recipients", { n: people.length, max: 10 })}</label>
        {people.length === 0 ? (
          <p className="rounded-xl border border-dashed border-accent-200 px-4 py-3 text-sm text-accent-400">{t("notify.empty")}</p>
        ) : (
          <ul className="divide-y divide-accent-100 rounded-xl ring-1 ring-inset ring-accent-200/60">
            {people.map((p) => (
              <li key={p.rid} className="flex items-center gap-3 px-3 py-2.5">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent-100 text-accent-600">
                  {p.kind === "group" ? <Users size={15} /> : <User size={15} />}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-accent-900">{p.name || t(`notify.kind.${p.kind}`)}</p>
                  <p className="font-mono text-xs text-accent-400">{p.hint}</p>
                </div>
                <button
                  type="button"
                  onClick={() => test(p.rid)}
                  disabled={busy !== null || !canTest}
                  title={t("notify.test_one")}
                  aria-label={t("notify.test_one")}
                  className="rounded-lg p-2 text-accent-500 hover:bg-accent-100 disabled:opacity-40"
                >
                  {busy === "test:" + p.rid ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
                </button>
                <button
                  type="button"
                  onClick={() => remove(p.rid)}
                  disabled={busy !== null}
                  title={t("notify.remove")}
                  aria-label={t("notify.remove")}
                  className="rounded-lg p-2 text-rose-500 hover:bg-rose-50 disabled:opacity-40"
                >
                  {busy === "rm:" + p.rid ? <Loader2 size={15} className="animate-spin" /> : <Trash2 size={15} />}
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_200px_auto]">
          <input
            className="field font-mono text-[13px]"
            autoComplete="off"
            spellCheck={false}
            value={newId}
            onChange={(e) => setNewId(e.target.value)}
            placeholder={t("notify.add_id")}
            aria-label={t("notify.add_id")}
          />
          <input className="field" autoComplete="off" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={t("notify.add_name")} aria-label={t("notify.add_name")} maxLength={60} />
          <Button variant="secondary" onClick={add} disabled={busy !== null || !newId.trim() || people.length >= 10}>
            {busy === "add" ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />} {t("notify.add")}
          </Button>
        </div>
        <p className="mt-1 text-xs text-accent-400">{t("notify.to_hint")}</p>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-end gap-3">
        {note && (
          <span className={`flex items-center gap-1 text-sm ${note.ok ? "text-emerald-700" : "text-rose-700"}`}>
            {note.ok && <Check size={15} />} {note.text}
          </span>
        )}
        <Button variant="secondary" onClick={() => test()} disabled={busy !== null || !canTest || people.length === 0}>
          {busy === "test:all" ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />} {t("notify.test")}
        </Button>
        <Button onClick={save} disabled={busy !== null}>
          {busy === "save" && <Loader2 size={15} className="animate-spin" />} {t("common.save")}
        </Button>
      </div>
    </section>
  );
}

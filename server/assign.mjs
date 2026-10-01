// Handing out the next piece of work.
//
// A queue that makes every contributor ask what is free, choose something, and then handle being
// refused is not a queue, it is a coordination problem wearing one. It also fails exactly when it
// matters most: put twenty people in a room and tell them to pick, and they all pick the biggest
// obvious thing and nineteen get refused.
//
// So the server assigns. A contributor says who they are and gets a unit nobody is working on. The
// decision is made here, on the server, against the live lease table, which is the only place it can
// be made correctly -- a client picking from a list it fetched a moment ago is racing every other
// client that fetched the same list.
import { scopesOverlap } from "./state.mjs";

// Tasks in the order work should be handed out: declared priority first (1 is most urgent), then the
// order the crew wrote them in, which is a crew's own statement of what matters.
function byPriority(tasks) {
  return tasks
    .map((t, i) => ({ t, i }))
    .sort((a, b) => (a.t.priority ?? 99) - (b.t.priority ?? 99) || a.i - b.i)
    .map((x) => x.t);
}

// The first scope of a task that no live lease overlaps. Scopes are handed out in the order the crew
// declared them, so a crew that wants a particular order gets it by writing them in that order.
// A unit is also not free if it is already done, or if it has defeated the last two agents sent to it.
// Without this, the first unit in the list is handed to every agent whose lease on it expired, and a
// scheduled task spends a week claiming the same unreadable charter school every hour and filing a bug
// each time. Seen live: Paideia Academies, Arizona, claimed thirteen times in two days.
const norm = (s) => String(s ?? "").trim().toLowerCase();
function spent(store, scope) {
  const f = (store.state.findings ?? []).filter((x) => norm(x.scope) === norm(scope));
  if (f.some((x) => x.status === "approved" || x.status === "pending")) return true;
  const week = Date.now() - 7 * 86400e3;
  const tries = f.filter((x) => !(x.record && x.record.quote && x.record.source) && Date.parse(x.timestamp ?? 0) > week);
  return tries.length >= 2;
}
function freeScope(task, held, store) {
  if (!Array.isArray(task.scopes) || !task.scopes.length) return null;
  return task.scopes.find((s) => !held.some((l) => scopesOverlap(l.scope, s)) && !(store && spent(store, s))) ?? null;
}

export function nextFreeUnit(crew, store, taskId) {
  const held = store.activeLeases();

  if (taskId) {
    const t = crew.tasksById[taskId];
    if (!t) return { ok: false, why: `No task '${taskId}'. Tasks: ${crew.tasks.map((x) => x.id).join(", ")}` };
    if (!Array.isArray(t.scopes) || !t.scopes.length) {
      // A task with no declared units cannot be assigned from, only claimed by name. Say which tasks
      // can, rather than leaving the caller to guess why an obvious request was refused.
      return {
        ok: false,
        why: `Task '${taskId}' does not list its units, so the server cannot pick one for you. Name a scope yourself, or omit task and let the server choose a task it can assign from.`,
        detail: { assignable_tasks: crew.tasks.filter((x) => x.scopes?.length).map((x) => x.id) },
      };
    }
    const scope = freeScope(t, held, store);
    if (!scope) {
      return {
        ok: false,
        why: `Every unit of '${taskId}' is leased, done, or has defeated the last two agents sent to it. Try again later, or ask a maintainer to add work.`,
        detail: { leased: held.filter((l) => l.task === taskId).map((l) => ({ scope: l.scope, until: l.expires_at })) },
      };
    }
    return { ok: true, task: taskId, scope };
  }

  for (const t of byPriority(crew.tasks)) {
    const scope = freeScope(t, held, store);
    if (scope) return { ok: true, task: t.id, scope };
  }
  return {
    ok: false,
    why: "Every unit of every task is leased, already on the record, or has defeated the last two agents sent to it. Try again later, or ask a maintainer to add work.",
    detail: { held: held.map((l) => ({ task: l.task, scope: l.scope, until: l.expires_at })) },
  };
}

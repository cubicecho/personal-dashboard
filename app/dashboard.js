/**
 * The dashboard page. Every widget is an independent query against the
 * stitched /graphql — one app being down or unauthenticated only greys out
 * its own card. Root fields are namespaced per plugin (autocal_*, notes_*,
 * philotes_*, eunomia_*) by the gateway.
 */

const TOKENS_KEY = 'pd.tokens';

const loadTokens = () => {
  try {
    return JSON.parse(localStorage.getItem(TOKENS_KEY)) ?? {};
  } catch {
    return {};
  }
};
const saveTokens = (tokens) =>
  localStorage.setItem(TOKENS_KEY, JSON.stringify(tokens));

/**
 * Returns `{ data, errors }`. Partial success is the normal case under
 * stitching — one upstream field erroring says nothing about the rest of the
 * response — so errors are handed back alongside whatever did resolve rather
 * than thrown. Only a response with no data at all throws.
 */
async function gql(query, variables = {}) {
  const headers = { 'content-type': 'application/json' };
  for (const [name, token] of Object.entries(loadTokens())) {
    if (token) headers[`x-${name}-token`] = token;
  }
  const res = await fetch('/graphql', {
    method: 'POST',
    headers,
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json().catch(() => null);
  const errors = body?.errors ?? [];
  if (body?.data == null)
    throw new Error(
      errors.map((e) => e.message).join('; ') ||
        `gateway returned ${res.status}`,
    );
  return { data: body.data, errors };
}

const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
};

const today = () => new Date().toISOString().slice(0, 10);
const addDays = (iso, n) => {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};
const fmtTime = (iso) =>
  iso
    ? new Date(iso).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
      })
    : '';
const fmtHours = (seconds) => {
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
};

// ── Widgets ──────────────────────────────────────────────────────────────────
// A widget = which plugin it needs + a query + a renderer of the result into
// its card body. To add one for a new plugin, append to this list.

const WIDGETS = [
  {
    plugin: 'autocal',
    title: "Today's schedule",
    query: () => `{
      autocal_mySchedule(timezone: ${JSON.stringify(Intl.DateTimeFormat().resolvedOptions().timeZone)}) {
        kind title scheduledStart scheduledEnd isScheduled isOverdue completedAt dueAt
      }
    }`,
    render(data, body) {
      const items = data.autocal_mySchedule ?? [];
      const dayStart = new Date(`${today()}T00:00:00`);
      const dayEnd = new Date(`${addDays(today(), 1)}T00:00:00`);
      const todays = items
        .filter(
          (i) =>
            i.scheduledStart &&
            new Date(i.scheduledStart) >= dayStart &&
            new Date(i.scheduledStart) < dayEnd,
        )
        .sort((a, b) => a.scheduledStart.localeCompare(b.scheduledStart));
      const overdue = items.filter((i) => i.isOverdue && !i.completedAt);

      if (!todays.length && !overdue.length)
        return body.append(el('p', 'empty', 'Nothing scheduled today.'));
      const list = el('ul', 'rows');
      for (const item of todays.slice(0, 10)) {
        const li = el('li');
        li.append(
          el(
            'span',
            'time',
            `${fmtTime(item.scheduledStart)}–${fmtTime(item.scheduledEnd)}`,
          ),
        );
        li.append(el('span', item.completedAt ? 'done' : '', item.title));
        li.append(el('span', 'sub', item.kind.toLowerCase()));
        list.append(li);
      }
      for (const item of overdue.slice(0, 5)) {
        const li = el('li');
        li.append(el('span', 'time overdue', 'overdue'));
        li.append(el('span', '', item.title));
        list.append(li);
      }
      body.append(list);
    },
  },
  {
    plugin: 'notes',
    title: 'Recent notes',
    query: () => '{ notes_myNotes { id title updatedAt } }',
    render(data, body) {
      const notes = (data.notes_myNotes ?? [])
        .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
        .slice(0, 6);
      if (!notes.length) return body.append(el('p', 'empty', 'No notes yet.'));
      const list = el('ul', 'rows');
      for (const note of notes) {
        const li = el('li');
        li.append(el('span', '', note.title || '(untitled)'));
        li.append(
          el('span', 'sub', new Date(note.updatedAt).toLocaleDateString()),
        );
        list.append(li);
      }
      body.append(list);
    },
  },
  {
    plugin: 'philotes',
    title: 'Upcoming dates',
    query: () => `{
      philotes_importantDates(limit: 300) {
        name date recurrence person { firstName lastName }
      }
    }`,
    render(data, body) {
      const now = today();
      const horizon = addDays(now, 60);
      // Annual recurrences (birthdays…) roll forward to their next occurrence.
      const upcoming = (data.philotes_importantDates ?? [])
        .map((d) => {
          let next = d.date;
          if (d.recurrence && next < now) {
            const monthDay = next.slice(4);
            next = `${now.slice(0, 4)}${monthDay}`;
            if (next < now) next = `${Number(now.slice(0, 4)) + 1}${monthDay}`;
          }
          return { ...d, next };
        })
        .filter((d) => d.next >= now && d.next <= horizon)
        .sort((a, b) => a.next.localeCompare(b.next))
        .slice(0, 8);
      if (!upcoming.length)
        return body.append(el('p', 'empty', 'Nothing in the next 60 days.'));
      const list = el('ul', 'rows');
      for (const d of upcoming) {
        const li = el('li');
        const who = d.person
          ? `${d.person.firstName} ${d.person.lastName}`.trim()
          : '';
        li.append(el('span', 'time', d.next.slice(5)));
        li.append(el('span', '', who ? `${who} — ${d.name}` : d.name));
        list.append(li);
      }
      body.append(list);
    },
  },
  {
    plugin: 'eunomia',
    title: 'Screen time today',
    query: () => `{
      eunomia_categorySummary(from: ${JSON.stringify(today())}, to: ${JSON.stringify(addDays(today(), 1))}) {
        name color seconds
      }
    }`,
    render(data, body) {
      const rows = (data.eunomia_categorySummary ?? [])
        .filter((r) => r.seconds > 60)
        .sort((a, b) => b.seconds - a.seconds)
        .slice(0, 8);
      if (!rows.length)
        return body.append(el('p', 'empty', 'No activity recorded today.'));
      const max = rows[0].seconds;
      for (const row of rows) {
        const wrap = el('div', 'bar-row');
        wrap.append(el('span', '', row.name ?? 'uncategorized'));
        const track = el('div', 'bar-track');
        const fill = el('div', 'bar-fill');
        fill.style.width = `${Math.max(3, (row.seconds / max) * 100)}%`;
        fill.style.background = row.color || 'var(--accent)';
        track.append(fill);
        wrap.append(track);
        wrap.append(el('span', 'sub', fmtHours(row.seconds)));
        body.append(wrap);
      }
    },
  },
];

// ── Shell ────────────────────────────────────────────────────────────────────

const grid = document.getElementById('grid');
const chips = document.getElementById('status-chips');

let pluginStatuses = [];

async function fetchStatuses() {
  try {
    const { data } = await gql('{ plugins { name url ok error } }');
    pluginStatuses = data.plugins ?? [];
  } catch (err) {
    pluginStatuses = [];
    console.error('gateway unreachable', err);
  }
  chips.replaceChildren(
    ...pluginStatuses.map((p) => {
      const chip = el('span', `chip ${p.ok ? 'ok' : 'bad'}`, p.name);
      if (!p.ok) chip.title = p.error ?? 'not stitched';
      return chip;
    }),
  );
}

async function renderWidget(widget) {
  let card = document.getElementById(`widget-${widget.plugin}`);
  if (!card) {
    card = el('section', 'card');
    card.id = `widget-${widget.plugin}`;
    grid.append(card);
  }
  card.replaceChildren(el('h2', '', widget.title));
  const body = el('div');
  card.append(body);

  const status = pluginStatuses.find((p) => p.name === widget.plugin);
  if (status && !status.ok) {
    body.append(
      el('p', 'error', `${widget.plugin} is not stitched — is it running?`),
    );
    return;
  }
  body.append(el('p', 'loading', 'Loading…'));
  try {
    const { data, errors } = await gql(widget.query());
    body.replaceChildren();
    try {
      widget.render(data, body);
    } catch (err) {
      // A partial response can be missing what render expects; the field
      // errors below explain why, so show those instead of a stack.
      if (!errors.length) throw err;
    }
    if (errors.length)
      body.append(
        el(
          'p',
          'error',
          `${errors.map((e) => e.message).join('; ')} — check its token in ⚙`,
        ),
      );
  } catch (err) {
    body.replaceChildren(
      el('p', 'error', `${err.message} — check its token in ⚙`),
    );
  }
}

async function refresh() {
  await fetchStatuses();
  await Promise.all(WIDGETS.map(renderWidget));
}

// ── Settings dialog ──────────────────────────────────────────────────────────

const dialog = document.getElementById('settings');
document.getElementById('settings-toggle').addEventListener('click', () => {
  const fields = document.getElementById('token-fields');
  const tokens = loadTokens();
  const names = pluginStatuses.length
    ? pluginStatuses.map((p) => p.name)
    : WIDGETS.map((w) => w.plugin);
  fields.replaceChildren(
    ...names.flatMap((name) => {
      const label = el('label', '', name);
      label.htmlFor = `token-${name}`;
      const input = el('input');
      input.id = `token-${name}`;
      input.type = 'password';
      input.placeholder = 'token / API key';
      input.value = tokens[name] ?? '';
      return [label, input];
    }),
  );
  dialog.showModal();
});
document.getElementById('save-tokens').addEventListener('click', () => {
  const tokens = {};
  for (const input of dialog.querySelectorAll('input')) {
    const name = input.id.replace(/^token-/, '');
    if (input.value.trim()) tokens[name] = input.value.trim();
  }
  saveTokens(tokens);
  refresh();
});

document.getElementById('refresh').addEventListener('click', refresh);
document
  .getElementById('reload-plugins')
  .addEventListener('click', async () => {
    const res = await fetch('/reload', { method: 'POST' }).catch(() => null);
    if (!res?.ok) {
      const why = await res?.json().then(
        (b) => b.error,
        () => null,
      );
      chips.replaceChildren(
        el('span', 'chip bad', `reload failed${why ? `: ${why}` : ''}`),
      );
      return;
    }
    refresh();
  });

refresh();
setInterval(refresh, 5 * 60 * 1000);

import { getSettings, saveSettings, DEFAULT_HIDE } from '../lib/settings.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));
let mappings = [];

function renderMappings() {
  const t = $('mappings');
  if (!mappings.length) {
    t.innerHTML = '<tbody><tr><td class="hint">No mappings yet. Run a check and enter the original page.</td></tr></tbody>';
    return;
  }
  t.innerHTML = `<thead><tr><th>Migrated site</th><th>Original site</th><th>Path prefix</th><th>Suffix</th><th></th></tr></thead><tbody>
    ${mappings.map((m, i) => `<tr data-i="${i}">
      <td>${esc(m.label)}</td>
      <td><input class="map-origin" data-f="origin" value="${esc(m.origin)}" aria-label="Original site"></td>
      <td><input class="map-origin" data-f="prefix" value="${esc(m.prefix)}" aria-label="Path prefix" placeholder="none"></td>
      <td><input class="map-origin" data-f="suffix" value="${esc(m.suffix)}" aria-label="Suffix" placeholder="none"></td>
      <td><button type="button" class="btn small" data-remove="${i}">Remove</button></td></tr>`).join('')}</tbody>`;
}

async function init() {
  const s = await getSettings();
  $('psiKey').value = s.psiKey;
  $('autoPsi').checked = s.autoPsi;
  $('psiStrategy').value = s.psiStrategy;
  $('hideSelectors').value = (s.hideSelectors || DEFAULT_HIDE).join('\n');
  mappings = s.mappings || [];
  renderMappings();

  $('mappings').addEventListener('click', (e) => {
    const rm = e.target.closest('[data-remove]');
    if (!rm) return;
    mappings.splice(Number(rm.dataset.remove), 1);
    renderMappings();
  });
  $('mappings').addEventListener('input', (e) => {
    const row = e.target.closest('[data-i]');
    if (row && e.target.dataset.f) mappings[Number(row.dataset.i)][e.target.dataset.f] = e.target.value.trim();
  });

  $('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const cleaned = mappings
      .map((m) => {
        try { return { ...m, origin: new URL(m.origin).origin }; } catch (err) { return null; }
      })
      .filter(Boolean);
    await saveSettings({
      psiKey: $('psiKey').value.trim(),
      autoPsi: $('autoPsi').checked,
      psiStrategy: $('psiStrategy').value,
      hideSelectors: $('hideSelectors').value.split('\n').map((l) => l.trim()).filter(Boolean),
      mappings: cleaned,
    });
    mappings = cleaned;
    renderMappings();
    $('saved').textContent = 'Saved.';
    setTimeout(() => { $('saved').textContent = ''; }, 2000);
  });
}

init();

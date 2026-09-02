import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("MB08-008/010: catalog UI has semantic states, localization, redacted projection, and responsive layout", async () => {
  const [component, locales, css, client] = await Promise.all([
    readFile(join(root, "src/client/WaitingEventsSection.tsx"), "utf8"),
    readFile(join(root, "src/client/locales.ts"), "utf8"),
    readFile(join(root, "src/client/WaitingEventsSection.module.css"), "utf8"),
    readFile(join(root, "src/client/index.ts"), "utf8"),
  ]);
  assert.match(component, /aria-labelledby="relay-bundle-catalog-title"/u);
  assert.match(component, /data-relay-bundle-status/u);
  assert.match(component, /bundle\.permissions/u);
  assert.match(component, /bundle\.remediation/u);
  assert.match(component, /bundle\.artifact_hash/u);
  assert.match(component, /\[list, request, eventCursor, bundleCursor, activeLocale\]/u,
    "localized catalog data must reload when the active locale changes");
  assert.match(client, /active\.startsWith\('zh'\) \? 'zh-CN' : 'en-US'/u,
    "DSH's zh locale id must map to the Bundle catalog's zh-CN contract locale");
  const bundleView = component.slice(component.indexOf("interface BundleTypeView"), component.indexOf("interface ConnectorView"));
  const bundleMarkup = component.slice(component.indexOf("data-relay-bundle-catalog"), component.indexOf("{connectors.length"));
  assert.doesNotMatch(`${bundleView}\n${bundleMarkup}`, /capability_grants|credential|secret_handle/u);
  for (const key of ["bundleCatalog", "noBundleTypes", "bundlePermissions", "bundleRemediation", "configuration_required"]) {
    assert.equal((locales.match(new RegExp(`\\b${key}:`, "gu")) ?? []).length, 2, `${key} must exist in both locales`);
  }
  assert.match(css, /@media \(max-width: 620px\)/u);
  assert.match(css, /var\(--dsw-alias-/u);
});

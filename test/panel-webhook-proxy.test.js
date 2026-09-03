import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("origem pública do painel encaminha somente API e webhooks ao backend", async () => {
  const nginx = await readFile(new URL("../infra/panel/nginx.conf", import.meta.url), "utf8");
  assert.match(nginx, /location \/api\/ \{/u);
  assert.match(nginx, /location = \/webhook \{/u);
  assert.match(nginx, /location \/webhook\/ \{/u);
  assert.equal((nginx.match(/proxy_pass http:\/\/api:3001;/gu) || []).length, 3);
  assert.match(nginx, /location \/ \{\s+try_files \$uri \$uri\/ \/index\.html;/u);
});

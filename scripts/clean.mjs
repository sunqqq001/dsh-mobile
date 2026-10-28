import { rm } from 'node:fs/promises'

for (const path of ['lib', 'coverage']) {
  await rm(new URL(`../${path}`, import.meta.url), { force: true, recursive: true })
}

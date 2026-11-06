#!/usr/bin/env node
import helper from '@prisma/generator-helper';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
helper.generatorHandler({
  onManifest() {
    return {
      defaultOutput: './tenantguard',
      prettyName: 'TenantGuard scalar model metadata',
    };
  },
  async onGenerate(options) {
    const output = options.generator.output?.value;
    if (!output) throw new Error('TenantGuard metadata output is required');
    await mkdir(output, { recursive: true });
    const models = options.dmmf.datamodel.models.map((model) => ({
      name: model.name,
      dbName: model.dbName ?? null,
      schema: model.schema ?? null,
      fields: model.fields.map((field) => ({
        name: field.name,
        dbName: field.dbName ?? null,
        kind: field.kind,
        type: field.type,
        isList: field.isList,
        isRequired: field.isRequired,
      })),
    }));
    await writeFile(
      join(output, 'datamodel.json'),
      JSON.stringify({ models }, null, 2) + '\n',
    );
  },
});

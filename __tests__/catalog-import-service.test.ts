import { describe, it, expect } from 'vitest';
import {
    parseCatalogFile,
    validateColumnMapping,
    buildImportPlan,
    REQUIRED_FIELDS_BY_MODE,
} from '../src/services/catalog-import-service.js';
import { CATALOG_IMPORT_MODES } from '../src/types/catalog-import.js';
import type { ColumnMapping } from '../src/schemas/catalog.js';

function csvBuffer(text: string): Buffer {
    return Buffer.from(text, 'utf8');
}

const FULL_MAPPING: ColumnMapping = {
    sku: 'SKU',
    name: 'Nombre',
    category: 'Categoria',
    price: 'Precio',
    presentation: 'Presentacion',
    stockStatus: 'Existencia',
};

const PRICE_ONLY_MAPPING: ColumnMapping = { sku: 'SKU', price: 'Precio' };

describe('src/services/catalog-import-service.ts — parseCatalogFile', () => {
    it('parsea un CSV en headers + filas', async () => {
        const csv = 'SKU,Nombre,Precio\nABC-001,Producto A,100\nABC-002,Producto B,200\n';
        const { headers, rows } = await parseCatalogFile(csvBuffer(csv), 'catalogo.csv', 'text/csv');
        expect(headers.filter(Boolean)).toEqual(['SKU', 'Nombre', 'Precio']);
        expect(rows).toHaveLength(2);
        expect(rows[0]).toMatchObject({ SKU: 'ABC-001', Nombre: 'Producto A', Precio: '100' });
    });

    it('omite filas completamente vacías', async () => {
        const csv = 'SKU,Nombre\nABC-001,Producto A\n,\nABC-002,Producto B\n';
        const { rows } = await parseCatalogFile(csvBuffer(csv), 'catalogo.csv', 'text/csv');
        expect(rows).toHaveLength(2);
    });
});

describe('src/services/catalog-import-service.ts — validateColumnMapping', () => {
    it('sin errores cuando todas las columnas mapeadas existen en el archivo', () => {
        const errors = validateColumnMapping(FULL_MAPPING, ['SKU', 'Nombre', 'Categoria', 'Precio', 'Presentacion', 'Existencia'], CATALOG_IMPORT_MODES.COMPLETO);
        expect(errors).toEqual([]);
    });

    it('contraparte de rechazo: falta la columna "name" obligatoria en modo completo', () => {
        const mapping = { sku: 'SKU' } as ColumnMapping;
        const errors = validateColumnMapping(mapping, ['SKU'], CATALOG_IMPORT_MODES.COMPLETO);
        expect(errors.some((e) => e.includes('name'))).toBe(true);
    });

    it('modo solo_precios exige sku+price, no name', () => {
        expect(REQUIRED_FIELDS_BY_MODE[CATALOG_IMPORT_MODES.SOLO_PRECIOS]).toEqual(['sku', 'price']);
        const errors = validateColumnMapping(PRICE_ONLY_MAPPING, ['SKU', 'Precio'], CATALOG_IMPORT_MODES.SOLO_PRECIOS);
        expect(errors).toEqual([]);
    });

    it('columna mapeada que no existe en el archivo produce error', () => {
        const errors = validateColumnMapping({ sku: 'SKU', price: 'ColumnaQueNoExiste' }, ['SKU', 'Precio'], CATALOG_IMPORT_MODES.SOLO_PRECIOS);
        expect(errors.some((e) => e.includes('ColumnaQueNoExiste'))).toBe(true);
    });
});

describe('src/services/catalog-import-service.ts — buildImportPlan (modo completo)', () => {
    it('SKU nuevo (no existe en el catálogo) cuenta como alta', () => {
        const rows = [{ SKU: 'NEW-001', Nombre: 'Producto nuevo', Precio: '100' }];
        const plan = buildImportPlan(rows, FULL_MAPPING, CATALOG_IMPORT_MODES.COMPLETO, new Set());
        expect(plan.toCreate).toBe(1);
        expect(plan.toUpdate).toBe(0);
        expect(plan.errors).toEqual([]);
    });

    it('contraparte: SKU que ya existe en el catálogo (sin distinguir mayúsculas) cuenta como cambio', () => {
        const rows = [{ SKU: 'exist-001', Nombre: 'Producto existente', Precio: '100' }];
        const plan = buildImportPlan(rows, FULL_MAPPING, CATALOG_IMPORT_MODES.COMPLETO, new Set(['EXIST-001']));
        expect(plan.toCreate).toBe(0);
        expect(plan.toUpdate).toBe(1);
    });

    it('SKU duplicado DENTRO del archivo (sin distinguir mayúsculas) se detecta y reporta como error', () => {
        const rows = [
            { SKU: 'DUP-001', Nombre: 'Primero', Precio: '100' },
            { SKU: 'dup-001', Nombre: 'Segundo (mismo SKU, otra capitalización)', Precio: '150' },
        ];
        const plan = buildImportPlan(rows, FULL_MAPPING, CATALOG_IMPORT_MODES.COMPLETO, new Set());
        expect(plan.duplicateSkusInFile).toEqual(['DUP-001']);
        expect(plan.errors.some((e) => e.message.includes('duplicado'))).toBe(true);
        // Solo la primera aparición se cuenta como fila válida.
        expect(plan.toCreate).toBe(1);
    });

    it('fila sin SKU es un error, no una alta silenciosa', () => {
        const rows = [{ SKU: '', Nombre: 'Sin SKU', Precio: '100' }];
        const plan = buildImportPlan(rows, FULL_MAPPING, CATALOG_IMPORT_MODES.COMPLETO, new Set());
        expect(plan.errors).toHaveLength(1);
        expect(plan.toCreate).toBe(0);
    });

    it('fila sin nombre (obligatorio en modo completo) es un error', () => {
        const rows = [{ SKU: 'X-001', Nombre: '', Precio: '100' }];
        const plan = buildImportPlan(rows, FULL_MAPPING, CATALOG_IMPORT_MODES.COMPLETO, new Set());
        expect(plan.errors.some((e) => e.message.includes('nombre'))).toBe(true);
    });

    it('valor de existencias no reconocido es un error con los valores válidos listados', () => {
        const rows = [{ SKU: 'X-001', Nombre: 'Producto', Existencia: 'valor-inventado' }];
        const plan = buildImportPlan(rows, FULL_MAPPING, CATALOG_IMPORT_MODES.COMPLETO, new Set());
        expect(plan.errors.some((e) => e.message.includes('valor-inventado'))).toBe(true);
    });

    it('contraparte: valor de existencias válido se acepta y queda en fields.stockStatus', () => {
        const rows = [{ SKU: 'X-001', Nombre: 'Producto', Existencia: 'disponible' }];
        const plan = buildImportPlan(rows, FULL_MAPPING, CATALOG_IMPORT_MODES.COMPLETO, new Set());
        expect(plan.validRows[0].fields.stockStatus).toBe('disponible');
    });

    it('precio no numérico es un error', () => {
        const rows = [{ SKU: 'X-001', Nombre: 'Producto', Precio: 'no-es-un-numero' }];
        const plan = buildImportPlan(rows, FULL_MAPPING, CATALOG_IMPORT_MODES.COMPLETO, new Set());
        expect(plan.errors.some((e) => e.message.includes('Precio'))).toBe(true);
    });

    it('columna imageUrl mapeada queda en fields.imageUrl cuando está presente', () => {
        const mapping: ColumnMapping = { ...FULL_MAPPING, imageUrl: 'Imagen' };
        const rows = [{ SKU: 'X-001', Nombre: 'Producto', Imagen: 'https://cdn.example.com/x.png' }];
        const plan = buildImportPlan(rows, mapping, CATALOG_IMPORT_MODES.COMPLETO, new Set());
        expect(plan.validRows[0].fields.imageUrl).toBe('https://cdn.example.com/x.png');
    });

    it('contraparte: sin columna imageUrl mapeada, fields.imageUrl queda undefined', () => {
        const rows = [{ SKU: 'X-001', Nombre: 'Producto' }];
        const plan = buildImportPlan(rows, FULL_MAPPING, CATALOG_IMPORT_MODES.COMPLETO, new Set());
        expect(plan.validRows[0].fields.imageUrl).toBeUndefined();
    });
});

describe('src/services/catalog-import-service.ts — buildImportPlan (modo solo_precios)', () => {
    it('SKU existente actualiza precio (cuenta como cambio, nunca como alta)', () => {
        const rows = [{ SKU: 'EXIST-001', Precio: '999' }];
        const plan = buildImportPlan(rows, PRICE_ONLY_MAPPING, CATALOG_IMPORT_MODES.SOLO_PRECIOS, new Set(['EXIST-001']));
        expect(plan.toUpdate).toBe(1);
        expect(plan.toCreate).toBe(0);
        expect(plan.validRows[0].fields).toEqual({ price: 999 });
    });

    it('contraparte de rechazo: SKU que NO existe en el catálogo es un error — solo_precios nunca crea productos', () => {
        const rows = [{ SKU: 'NO-EXISTE', Precio: '999' }];
        const plan = buildImportPlan(rows, PRICE_ONLY_MAPPING, CATALOG_IMPORT_MODES.SOLO_PRECIOS, new Set());
        expect(plan.toCreate).toBe(0);
        expect(plan.toUpdate).toBe(0);
        expect(plan.errors).toHaveLength(1);
        expect(plan.errors[0].message).toContain('no existe en el catálogo');
    });

    it('las filas válidas de solo_precios NUNCA incluyen campos descriptivos (name, category, etc.)', () => {
        const rows = [{ SKU: 'EXIST-001', Precio: '50' }];
        const plan = buildImportPlan(rows, PRICE_ONLY_MAPPING, CATALOG_IMPORT_MODES.SOLO_PRECIOS, new Set(['EXIST-001']));
        expect(Object.keys(plan.validRows[0].fields)).toEqual(['price']);
    });
});

import { describe, it, expect } from 'vitest';
import {
    generateProductKbDocument,
    computeKbDocumentHash,
    NoActiveVariantsError,
    type CatalogProductForKb,
    type CatalogVariantForKb,
} from '../src/services/catalog-kb-document.js';

const ARNICA_PRODUCT: CatalogProductForKb = {
    name: 'Gel de árnica 60 ml',
    category: 'Analgésicos tópicos',
    activeComponents: 'árnica montana al 10%, mentol, alcanfor',
    suggestedUse: 'aplicar sobre la zona adolorida dos o tres veces al día.',
    description: 'Indicado para dolor muscular, golpes e inflamación de rodilla.',
    contraindications: 'no aplicar sobre heridas abiertas.',
};

const ARNICA_VARIANTS: CatalogVariantForKb[] = [
    { sku: 'ARN-GEL-060', presentation: '60 ml', isActive: true },
    { sku: 'ARN-GEL-120', presentation: '120 ml', isActive: true },
];

const EXPECTED_DOCUMENT = [
    'SKU: ARN-GEL-060',
    '',
    'Gel de árnica 60 ml',
    'Categoría: Analgésicos tópicos',
    'Componentes activos: árnica montana al 10%, mentol, alcanfor',
    'Uso sugerido: aplicar sobre la zona adolorida dos o tres veces al día.',
    'Indicado para dolor muscular, golpes e inflamación de rodilla.',
    'Contraindicaciones: no aplicar sobre heridas abiertas.',
    'Presentaciones: 60 ml, 120 ml.',
    '',
    'Para precio y disponibilidad, consultar SKU ARN-GEL-060.',
].join('\n');

describe('src/services/catalog-kb-document.ts — generateProductKbDocument', () => {
    it('genera exactamente la plantilla de docs/tasks/catalogo-productos-grupos-cred.md FASE C.1', () => {
        expect(generateProductKbDocument(ARNICA_PRODUCT, ARNICA_VARIANTS)).toBe(EXPECTED_DOCUMENT);
    });

    /**
     * LA PRUEBA CENTRAL del módulo (regla número 1 del task doc): el
     * documento generado NUNCA contiene precio ni existencias. Debe fallar
     * la suite si esta regla se rompe.
     */
    describe('regla inviolable: sin precio ni existencias', () => {
        const product: CatalogProductForKb = {
            name: 'Producto con todos los campos llenos',
            category: 'Categoría de prueba',
            activeComponents: 'componente A, componente B',
            suggestedUse: 'usar según indicaciones.',
            description: 'Descripción larga del producto para pruebas.',
            contraindications: 'no usar en menores de edad.',
        };
        const variants: CatalogVariantForKb[] = [
            { sku: 'TEST-SKU-001', presentation: '250 ml', isActive: true },
            { sku: 'TEST-SKU-002', presentation: '500 ml', isActive: true },
        ];
        const document = generateProductKbDocument(product, variants);

        it('no contiene el símbolo de moneda "$"', () => {
            expect(document).not.toContain('$');
        });

        it('no contiene ninguna palabra que afirme un precio real (costo, cuesta, IVA, tarifa) — "precio" en sí SÍ aparece, deliberadamente, en la instrucción final de redirigir al tool', () => {
            const lower = document.toLowerCase();
            expect(lower).not.toMatch(/costo|cuesta|\biva\b|tarifa/);
            // La única mención de "precio" es la instrucción de cierre, nunca
            // un valor: no debe ir seguida de un monto en la misma oración.
            expect(lower).toContain('para precio y disponibilidad, consultar sku');
        });

        it('no contiene ningún monto monetario (número con dos decimales, forma típica de un precio)', () => {
            expect(document).not.toMatch(/\d+\.\d{2}/);
        });

        it('no contiene ninguna palabra relacionada con existencias (disponible, stock, existencia, agotado, inventario)', () => {
            const lower = document.toLowerCase();
            expect(lower).not.toMatch(/disponible|stock|existenc|agotad|inventario|piezas?\b/);
        });

        it('la función no acepta price/stock como parámetro — imposible de filtrar porque no existe el campo', () => {
            // Verificación estructural: CatalogProductForKb no declara price ni stock_status.
            const keys = Object.keys(product);
            expect(keys).not.toContain('price');
            expect(keys).not.toContain('stock');
            expect(keys).not.toContain('stockStatus');
        });
    });

    describe('SKU canónico y presentaciones', () => {
        it('el SKU canónico es el alfabéticamente menor entre las variantes activas, sin importar el orden de entrada', () => {
            const variants: CatalogVariantForKb[] = [
                { sku: 'ZZZ-999', presentation: 'grande', isActive: true },
                { sku: 'AAA-001', presentation: 'chico', isActive: true },
            ];
            const doc = generateProductKbDocument(ARNICA_PRODUCT, variants);
            expect(doc.startsWith('SKU: AAA-001')).toBe(true);
            expect(doc.endsWith('SKU AAA-001.')).toBe(true);
        });

        it('ignora variantes inactivas tanto para el SKU canónico como para las presentaciones', () => {
            const variants: CatalogVariantForKb[] = [
                { sku: 'ACT-001', presentation: 'activa', isActive: true },
                { sku: 'INA-000', presentation: 'inactiva-no-debe-salir', isActive: false },
            ];
            const doc = generateProductKbDocument(ARNICA_PRODUCT, variants);
            expect(doc.startsWith('SKU: ACT-001')).toBe(true);
            expect(doc).not.toContain('inactiva-no-debe-salir');
        });

        it('deduplica presentaciones repetidas entre variantes', () => {
            const variants: CatalogVariantForKb[] = [
                { sku: 'DUP-001', presentation: '60 ml', isActive: true },
                { sku: 'DUP-002', presentation: '60 ml', isActive: true },
            ];
            const doc = generateProductKbDocument(ARNICA_PRODUCT, variants);
            expect(doc).toContain('Presentaciones: 60 ml.');
        });

        it('contraparte de rechazo: sin ninguna variante activa, lanza NoActiveVariantsError', () => {
            expect(() => generateProductKbDocument(ARNICA_PRODUCT, [{ sku: 'X', presentation: null, isActive: false }])).toThrow(
                NoActiveVariantsError
            );
        });
    });

    describe('campos opcionales ausentes se omiten sin dejar líneas vacías ni "null"', () => {
        it('producto sin category/activeComponents/suggestedUse/description/contraindications genera solo nombre + SKU', () => {
            const minimalProduct: CatalogProductForKb = {
                name: 'Producto mínimo',
                category: null,
                activeComponents: null,
                suggestedUse: null,
                description: null,
                contraindications: null,
            };
            const variants: CatalogVariantForKb[] = [{ sku: 'MIN-001', presentation: null, isActive: true }];
            const doc = generateProductKbDocument(minimalProduct, variants);
            expect(doc).toBe(['SKU: MIN-001', '', 'Producto mínimo', '', 'Para precio y disponibilidad, consultar SKU MIN-001.'].join('\n'));
            expect(doc).not.toContain('null');
            expect(doc).not.toContain('undefined');
        });
    });
});

describe('src/services/catalog-kb-document.ts — computeKbDocumentHash', () => {
    it('el mismo contenido produce el mismo hash', () => {
        const doc = generateProductKbDocument(ARNICA_PRODUCT, ARNICA_VARIANTS);
        expect(computeKbDocumentHash(doc)).toBe(computeKbDocumentHash(doc));
    });

    it('contraparte: un cambio de descripción (contenido distinto) produce un hash distinto', () => {
        const original = generateProductKbDocument(ARNICA_PRODUCT, ARNICA_VARIANTS);
        const changed = generateProductKbDocument({ ...ARNICA_PRODUCT, description: 'Descripción cambiada.' }, ARNICA_VARIANTS);
        expect(computeKbDocumentHash(original)).not.toBe(computeKbDocumentHash(changed));
    });

});

// Un cambio de precio no puede afectar computeKbDocumentHash: CatalogProductForKb
// no declara `price`, así que es estructuralmente imposible que el precio
// forme parte del contenido hasheado. La prueba de integración real (que un
// UPDATE de precio en product_variants no marca product_kb_sync como
// pendiente, y que un cambio de descripción sí) vive contra la base real en
// __tests__/sync-catalog-kb.test.ts, ejercitando
// db/migrations/56_catalogo_productos.sql BLOQUE 8 (mark_product_for_kb_sync()).

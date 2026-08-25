import { describe, it, expect } from 'vitest';
import {
    parseCustomFieldValue,
    validateColumnMapping,
    buildImportPlan,
    type CustomFieldDefinitionForImport,
} from '../src/services/catalog-import-service.js';
import { generateProductKbDocument, type CatalogProductForKb, type CatalogVariantForKb } from '../src/services/catalog-kb-document.js';
import { CATALOG_IMPORT_MODES } from '../src/types/catalog-import.js';

describe('Importación y RAG de Campos Personalizados de Catálogo', () => {
    describe('parseCustomFieldValue', () => {
        const textField: CustomFieldDefinitionForImport = {
            id: '1',
            key: 'material',
            name: 'Material',
            entity_type: 'product',
            field_type: 'text',
            options: [],
            is_required: false,
        };

        const numberField: CustomFieldDefinitionForImport = {
            id: '2',
            key: 'puntos',
            name: 'Puntos',
            entity_type: 'product',
            field_type: 'number',
            options: [],
            is_required: false,
        };

        const boolField: CustomFieldDefinitionForImport = {
            id: '3',
            key: 'requiere_receta',
            name: 'Requiere Receta',
            entity_type: 'product',
            field_type: 'boolean',
            options: [],
            is_required: false,
        };

        const selectField: CustomFieldDefinitionForImport = {
            id: '4',
            key: 'talla',
            name: 'Talla',
            entity_type: 'variant',
            field_type: 'select',
            options: ['Chica', 'Mediana', 'Grande'],
            is_required: true,
        };

        it('parsea campo de texto correctamente', () => {
            expect(parseCustomFieldValue('Algodón 100%', textField)).toEqual({ value: 'Algodón 100%' });
            expect(parseCustomFieldValue('', textField)).toEqual({ value: null });
        });

        it('parsea números con formato y decimales', () => {
            expect(parseCustomFieldValue('150', numberField)).toEqual({ value: 150 });
            expect(parseCustomFieldValue(' 1,250.50 ', numberField)).toEqual({ value: 1250.5 });
            expect(parseCustomFieldValue('abc', numberField).error).toBeDefined();
        });

        it('parsea booleanos (si, no, true, false, 1, 0)', () => {
            expect(parseCustomFieldValue('si', boolField)).toEqual({ value: true });
            expect(parseCustomFieldValue('SÍ', boolField)).toEqual({ value: true });
            expect(parseCustomFieldValue('true', boolField)).toEqual({ value: true });
            expect(parseCustomFieldValue('1', boolField)).toEqual({ value: true });
            expect(parseCustomFieldValue('no', boolField)).toEqual({ value: false });
            expect(parseCustomFieldValue('false', boolField)).toEqual({ value: false });
            expect(parseCustomFieldValue('0', boolField)).toEqual({ value: false });
            expect(parseCustomFieldValue('talvez', boolField).error).toBeDefined();
        });

        it('parsea select validando pertenencia a options', () => {
            expect(parseCustomFieldValue('Mediana', selectField)).toEqual({ value: 'Mediana' });
            expect(parseCustomFieldValue('mediana', selectField)).toEqual({ value: 'Mediana' }); // case-insensitive match
            expect(parseCustomFieldValue('Extra Grande', selectField).error).toBeDefined();
        });

        it('rechaza campo obligatorio vacío', () => {
            const res = parseCustomFieldValue('', selectField);
            expect(res.error).toContain('obligatorio');
        });
    });

    describe('validateColumnMapping con campos personalizados', () => {
        const customDefs: CustomFieldDefinitionForImport[] = [
            { id: '1', key: 'puntos', name: 'Puntos', entity_type: 'product', field_type: 'number', options: [], is_required: false },
        ];

        it('acepta mapeo con encabezado válido para campo personalizado', () => {
            const errors = validateColumnMapping(
                { sku: 'SKU', name: 'Nombre', customFields: { puntos: 'Puntos Lealtad' } },
                ['SKU', 'Nombre', 'Puntos Lealtad'],
                CATALOG_IMPORT_MODES.COMPLETO,
                customDefs
            );
            expect(errors).toHaveLength(0);
        });

        it('reporta error si el encabezado mapeado no existe en el archivo', () => {
            const errors = validateColumnMapping(
                { sku: 'SKU', name: 'Nombre', customFields: { puntos: 'Columna Inexistente' } },
                ['SKU', 'Nombre'],
                CATALOG_IMPORT_MODES.COMPLETO,
                customDefs
            );
            expect(errors.length).toBeGreaterThan(0);
            expect(errors[0]).toContain('no existe en el archivo');
        });

        it('reporta error si el key mapeado no existe en las definiciones del catálogo', () => {
            const errors = validateColumnMapping(
                { sku: 'SKU', name: 'Nombre', customFields: { no_existe: 'Col' } },
                ['SKU', 'Nombre', 'Col'],
                CATALOG_IMPORT_MODES.COMPLETO,
                customDefs
            );
            expect(errors.length).toBeGreaterThan(0);
            expect(errors[0]).toContain('no está configurado');
        });
    });

    describe('buildImportPlan con campos personalizados', () => {
        const customDefs: CustomFieldDefinitionForImport[] = [
            { id: '1', key: 'puntos', name: 'Puntos', entity_type: 'product', field_type: 'number', options: [], is_required: false },
            { id: '2', key: 'talla', name: 'Talla', entity_type: 'variant', field_type: 'select', options: ['S', 'M', 'L'], is_required: false },
        ];

        it('extrae y agrupa campos personalizados de producto y de variante', () => {
            const rows = [
                { 'Código': 'SKU-001', 'Producto': 'Camisa Oxford', 'Puntos': '50', 'Talla': 'M' },
                { 'Código': 'SKU-002', 'Producto': 'Pantalón Chino', 'Puntos': '80', 'Talla': 'L' },
            ];

            const plan = buildImportPlan(
                rows,
                {
                    sku: 'Código',
                    name: 'Producto',
                    customFields: { puntos: 'Puntos', talla: 'Talla' },
                },
                CATALOG_IMPORT_MODES.COMPLETO,
                new Set(),
                customDefs
            );

            expect(plan.errors).toHaveLength(0);
            expect(plan.validRows).toHaveLength(2);

            const firstRow = plan.validRows[0];
            expect(firstRow.fields.productCustomFields).toEqual({ puntos: 50 });
            expect(firstRow.fields.variantCustomFields).toEqual({ talla: 'M' });
        });

        it('reporta error en la fila si un campo personalizado tiene un valor inválido', () => {
            const rows = [
                { 'Código': 'SKU-001', 'Producto': 'Camisa Oxford', 'Puntos': 'NO_ES_NUMERO', 'Talla': 'M' },
            ];

            const plan = buildImportPlan(
                rows,
                {
                    sku: 'Código',
                    name: 'Producto',
                    customFields: { puntos: 'Puntos', talla: 'Talla' },
                },
                CATALOG_IMPORT_MODES.COMPLETO,
                new Set(),
                customDefs
            );

            expect(plan.errors).toHaveLength(1);
            expect(plan.errors[0].message).toContain('no es un número válido');
            expect(plan.validRows).toHaveLength(0);
        });
    });

    describe('generateProductKbDocument con customFields', () => {
        const product: CatalogProductForKb = {
            name: 'Proteína Whey Isolate',
            category: 'Suplementos',
            activeComponents: 'Aislado de suero de leche, BCAA',
            suggestedUse: '1 scoop con 250ml de agua después de entrenar',
            description: 'Proteína de máxima pureza para recuperación muscular.',
            contraindications: 'No exceder la porción recomendada.',
            customFields: [
                { name: 'Puntos de Lealtad', value: 120 },
                { name: 'Sabor', value: 'Chocolate Suizo' },
            ],
        };

        const variants: CatalogVariantForKb[] = [
            { sku: 'PROT-CHOC-2LB', presentation: 'Bote 2 lbs', isActive: true },
        ];

        it('incluye las líneas de campos personalizados en el documento de RAG', () => {
            const doc = generateProductKbDocument(product, variants);

            expect(doc).toContain('SKU: PROT-CHOC-2LB');
            expect(doc).toContain('Proteína Whey Isolate');
            expect(doc).toContain('Puntos de Lealtad: 120');
            expect(doc).toContain('Sabor: Chocolate Suizo');
            expect(doc).toContain('Para precio y disponibilidad, consultar SKU PROT-CHOC-2LB.');

            // Regla de oro: NUNCA incluye precio
            expect(doc).not.toMatch(/\$\d+/);
            expect(doc).not.toContain('precio:');
        });
    });
});

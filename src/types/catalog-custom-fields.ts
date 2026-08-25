/**
 * Tipos de entidad y tipos de datos para campos personalizados en catálogo.
 */
export const CUSTOM_FIELD_ENTITY_TYPES = {
    PRODUCT: 'product',
    VARIANT: 'variant',
} as const;
export type CustomFieldEntityType = (typeof CUSTOM_FIELD_ENTITY_TYPES)[keyof typeof CUSTOM_FIELD_ENTITY_TYPES];

export const CUSTOM_FIELD_TYPES = {
    TEXT: 'text',
    NUMBER: 'number',
    BOOLEAN: 'boolean',
    SELECT: 'select',
} as const;
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[keyof typeof CUSTOM_FIELD_TYPES];

export interface CatalogCustomField {
    id: string;
    catalog_id: string;
    entity_type: CustomFieldEntityType;
    name: string;
    key: string;
    field_type: CustomFieldType;
    options: string[];
    description: string | null;
    is_required: boolean;
    include_in_rag: boolean;
    order_index: number;
    created_at: string;
    updated_at: string;
}

export interface CatalogCustomFieldDTO {
    id: string;
    catalogId: string;
    entityType: CustomFieldEntityType;
    name: string;
    key: string;
    fieldType: CustomFieldType;
    options: string[];
    description: string | null;
    isRequired: boolean;
    includeInRag: boolean;
    orderIndex: number;
    createdAt: string;
    updatedAt: string;
}

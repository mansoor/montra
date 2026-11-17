/** The tax form reading chain (ADR-0052 §6): the doc-worker's `taxform.read`, then the Node `tax_form.match`. */
export const TAX_FORM_JOB_TYPES = ['taxform.read', 'tax_form.match'] as const;

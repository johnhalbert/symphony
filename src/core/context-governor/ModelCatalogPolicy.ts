export interface RuntimeModelParameterValue {
  id: string;
  value: string;
}

export interface RuntimeModelSelection {
  id: string;
  params?: RuntimeModelParameterValue[] | undefined;
}

export interface RuntimeModelParameterOption {
  value: string;
  displayName?: string | undefined;
}

export interface RuntimeModelParameterDefinition {
  id: string;
  values: RuntimeModelParameterOption[];
}

export interface RuntimeModelVariant {
  displayName?: string | undefined;
  isDefault?: boolean | undefined;
  params: RuntimeModelParameterValue[];
}

export interface RuntimeModel {
  id: string;
  displayName?: string | undefined;
  parameters?: RuntimeModelParameterDefinition[] | undefined;
  variants?: RuntimeModelVariant[] | undefined;
}

export interface ModelCatalogPolicyOptions {
  allowLargeContext: boolean;
  largeContextValues?: string[];
}

export interface ModelCatalogValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  modelId: string;
  requestedParams: RuntimeModelParameterValue[];
}

export function validateModelSelection(
  catalog: readonly RuntimeModel[],
  selection: RuntimeModelSelection,
  options: ModelCatalogPolicyOptions,
): ModelCatalogValidationResult {
  const requestedParams = [...(selection.params ?? [])];
  const errors: string[] = [];
  const warnings: string[] = [];
  const model = catalog.find((candidate) => candidate.id === selection.id);
  if (!model) {
    errors.push(`Model ${selection.id} is not available in Cursor.models.list()`);
    return { ok: false, errors, warnings, modelId: selection.id, requestedParams };
  }

  const parameters = model.parameters ?? [];
  const parametersById = new Map(parameters.map((parameter) => [parameter.id, parameter]));
  for (const param of requestedParams) {
    const definition = parametersById.get(param.id);
    if (!definition) {
      errors.push(`Model ${selection.id} does not expose parameter ${param.id}`);
      continue;
    }
    if (!definition.values.some((value) => value.value === param.value)) {
      errors.push(
        `Model ${selection.id} parameter ${param.id} does not allow value ${param.value}; allowed values: ${definition.values
          .map((value) => value.value)
          .join(", ")}`,
      );
    }
  }

  for (const parameter of parameters) {
    if (!requestedParams.some((param) => param.id === parameter.id)) {
      warnings.push(`Model ${selection.id} parameter ${parameter.id} was not specified; Cursor may use a default value`);
    }
  }

  const largeContextValues = new Set(options.largeContextValues ?? ["1m"]);
  const requestedContext = requestedParams.find((param) => param.id === "context")?.value ?? null;
  if (!options.allowLargeContext && requestedContext !== null && largeContextValues.has(requestedContext)) {
    errors.push(`Large context value ${requestedContext} requires allowLargeContext=true`);
  }

  const defaultVariant = model.variants?.find((variant) => variant.isDefault);
  const defaultContext = defaultVariant?.params.find((param) => param.id === "context")?.value ?? null;
  if (!options.allowLargeContext && requestedContext === null && defaultContext !== null && largeContextValues.has(defaultContext)) {
    errors.push(
      `Model ${selection.id} default context is ${defaultContext}; specify a bounded context or allow large context explicitly`,
    );
  }

  return { ok: errors.length === 0, errors, warnings, modelId: selection.id, requestedParams };
}

export function parseModelParamPairs(input: string): RuntimeModelParameterValue[] {
  if (input.trim().length === 0 || input.trim().toLowerCase() === "none") return [];
  return input.split(",").map((pair) => {
    const [id, value, ...extra] = pair.split("=");
    if (!id || !value || extra.length > 0) {
      throw new Error(`Invalid model param pair: ${pair}. Expected id=value.`);
    }
    return { id: id.trim(), value: value.trim() };
  });
}

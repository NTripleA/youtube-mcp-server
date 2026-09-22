/**
 * Server-side argument validation.
 *
 * Compiled from the SAME JSON Schemas published in tools/list, so the advertised
 * contract and the enforced contract cannot drift. `additionalProperties: false`
 * means unknown fields are rejected rather than silently ignored - a silently
 * ignored field is how a caller ends up believing it changed something it did not.
 */

import Ajv from "ajv";
import { TOOL_DEFINITIONS } from "./tools.js";

const AjvConstructor = Ajv.default ?? Ajv;

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
  }
}

const ajv = new AjvConstructor({
  allErrors: true,
  strict: false,
  coerceTypes: false,
  useDefaults: false,
});

const validators = new Map();
for (const tool of TOOL_DEFINITIONS) {
  validators.set(tool.name, ajv.compile(tool.inputSchema));
}

function formatErrors(errors) {
  return (errors ?? [])
    .map((error) => {
      const location = error.instancePath ? error.instancePath.replace(/^\//, "") : "arguments";
      if (error.keyword === "additionalProperties") {
        return `unknown field "${error.params.additionalProperty}"`;
      }
      if (error.keyword === "required") {
        return `missing required field "${error.params.missingProperty}"`;
      }
      return `${location} ${error.message}`;
    })
    .join("; ");
}

/**
 * Validate arguments for a tool. Throws ValidationError on any problem.
 * Returns the normalized arguments object.
 */
export function validateToolArgs(name, rawArgs) {
  const args = rawArgs ?? {};

  if (typeof args !== "object" || Array.isArray(args)) {
    throw new ValidationError(`Arguments for ${name} must be an object`);
  }

  // Explicit, pointed rejection rather than the generic unknown-field message:
  // silently dropping privacyStatus here is exactly the failure mode that makes
  // a caller think it changed a video's visibility when it did not.
  if (
    name === "update_video" &&
    Object.prototype.hasOwnProperty.call(args, "privacyStatus")
  ) {
    throw new ValidationError(
      "update_video cannot change privacy. It sends only the snippet part, so " +
        "privacyStatus is not applicable here - use set_video_privacy instead."
    );
  }

  const validate = validators.get(name);
  if (!validate) {
    throw new ValidationError(`Unknown tool: ${name}`);
  }

  if (!validate(args)) {
    throw new ValidationError(
      `Invalid arguments for ${name}: ${formatErrors(validate.errors)}`
    );
  }

  return args;
}

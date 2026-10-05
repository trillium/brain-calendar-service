// Declarations for the repo's plain-JS modules that TypeScript must not
// infer as `any`. Binding rule 1 is `noExplicitAny` as an error, so the honest
// options are a real declaration or a real type - not an escape hatch.
declare module "*.mjs" {
  const value: unknown;
  export = value;
}

// Bun's bundler turns an imported SVG into its URL, or into its text with `with { type: "text" }`.
declare module "*.svg" {
  const value: string;
  export default value;
}

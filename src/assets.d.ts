// Images imported from src/assets are bundled by Vite; this tells TypeScript that the import gives back a URL.
declare module '*.png' {
  const url: string;
  export default url;
}

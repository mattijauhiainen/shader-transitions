
Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## Frontend

The frontend is deployed as a static site. Do not add any features that would require more than a simple webserver. The build output will be deployed to netlify and needs to work without javascript running on the server side.

## Conventions

Run biome after all your code changes to ensure consistent formatting.

GLSL uniform naming: scene uniforms (set once at init) use `SCREAMING_CASE` with a `u` prefix (e.g. `uGRID_SIZE`, `uCELL_SIZE`, `uPITCH`). Per-frame uniforms (set each render call) use `camelCase` with a `u` prefix (e.g. `uTime`, `uPhase`, `uCamPos`).

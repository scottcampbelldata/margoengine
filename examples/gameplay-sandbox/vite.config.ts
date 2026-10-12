import {defineConfig} from 'vite';

// Consume public package exports so this example also tests the built distribution.
export default defineConfig({server: {host: '127.0.0.1'}, build: {target: 'es2022'}});

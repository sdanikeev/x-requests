import xclient, { isHttpError } from '../src/index.js';

type Routes = {
  '/todos/{id}': {
    get: {
      path: { id: number };
      response: { id: number; title: string; completed: boolean };
      errors: { 404: Record<string, never> };
    };
  };
};

const api = xclient<Routes>({ config: { baseUrl: 'https://jsonplaceholder.typicode.com' } });

const result = await api.get('/todos/{id}', { id: 1 }).timeout(5000).retries(2).result();

if (result.ok) {
  console.log(result.data.title);
} else if (isHttpError(result.error, 404)) {
  console.log('not found');
} else {
  console.error(result.error.kind);
}

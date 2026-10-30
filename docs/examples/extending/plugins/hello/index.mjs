// activate(api) is called once at load. Everything registered here is tagged source "plugin:hello",
// and is undone if activate throws or takes longer than the loader's timeout (5 s by default).
export default function activate(api) {
  api.register({
    kind: 'tool',
    id: 'hello-tool',
    title: 'Hello tool',
    value: { description: 'Returns a greeting', run: (name) => `hello, ${name}` },
  });
  api.register({ kind: 'panel', id: 'hello-panel', title: 'Hello panel', value: { route: '/hello' } });
}

export const responseFactories = [
  { name: "detail", path: (ids) => `/detail/${ids.itemId}` },
];

export function configureMock(mock, enabled) {
  return mock
    .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ first: true }) })
    .mockImplementation(() => enabled
      ? Promise.resolve({ ok: true, json: () => Promise.resolve({ enabled: true }) })
      : Promise.resolve({ ok: false, json: () => Promise.resolve({ enabled: false }) }));
}

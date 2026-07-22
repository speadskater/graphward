export function authorize(user) {
  return Boolean(user?.active);
}

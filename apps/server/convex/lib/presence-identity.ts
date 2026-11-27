const PRESENCE_COLORS = [
  "#e06c75",
  "#61afef",
  "#c678dd",
  "#98c379",
  "#e5c07b",
  "#56b6c2",
  "#be5046",
  "#d19a66",
];

export function presenceIdentity(user: {
  name?: string;
  email?: string;
  image?: string;
  github_avatar_url?: string;
}) {
  const name = user.name || user.email || "Anonymous";
  return {
    user_name: name,
    user_color: PRESENCE_COLORS[name.charCodeAt(0) % PRESENCE_COLORS.length],
    user_image: user.image || user.github_avatar_url || undefined,
  };
}

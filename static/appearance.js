try {
  const choice = localStorage.getItem("pulse.appearance");

  if (choice === "light" || choice === "dark") document.documentElement.dataset.appearance = choice;
} catch {
  // Use the system theme if storage is not available.
}

// Escape text for HTML, in element content and in quoted attribute values. Every page builds its markup from template
// strings, so anything that didn't come from our own code goes through this. null and undefined become ''.
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

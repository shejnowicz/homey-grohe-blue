function formatMeasurementTimestamp(value, { locale, timeZone } = {}) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  const options = {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    ...(timeZone ? { timeZone } : {}),
  };
  try {
    return new Intl.DateTimeFormat(locale || undefined, options).format(date);
  } catch (_error) {
    return new Intl.DateTimeFormat('en-GB', {
      ...options,
      timeZone: 'UTC',
    }).format(date);
  }
}

module.exports = { formatMeasurementTimestamp };

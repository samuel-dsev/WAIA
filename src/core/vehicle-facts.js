export function vehicleMileageKm(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 9_999_999 ? value : undefined;
}

export function vehicleYear(value) {
  return Number.isSafeInteger(value) && value >= 1886 && value <= 2100 ? value : undefined;
}

export function websiteVehicleFacts(value) {
  const mileageKm = vehicleMileageKm(value?.mileageKm), year = vehicleYear(value?.year);
  return { ...(mileageKm === undefined ? {} : { mileageKm }), ...(year === undefined ? {} : { year }) };
}

const mileageFormat = new Intl.NumberFormat("pt-BR");
export function vehicleFactsText(value) {
  const { mileageKm, year } = websiteVehicleFacts(value);
  if (mileageKm === undefined && year === undefined) return "Quilometragem e ano não informados";
  return `${mileageKm === undefined ? "Quilometragem não informada" : mileageFormat.format(mileageKm) + " km"} - ${year ?? "Ano não informado"}`;
}

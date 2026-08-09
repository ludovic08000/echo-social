import * as canonical from '../messaging/currentDevice';

/**
 * Façade device-manager : uniquement les accesseurs réellement consommés par
 * le runtime. Aucun signal matériel ne participe à l'identité ou à la confiance.
 */
export const setCurrentDeviceUserScope = canonical.setCurrentDeviceUserScope;
export const setCurrentDeviceId = canonical.setCurrentDeviceId;
export const getCurrentDeviceId = canonical.getCurrentDeviceId;
export const peekCurrentDeviceId = canonical.peekCurrentDeviceId;
export const getDeviceIdStatus = canonical.getDeviceIdStatus;
export const isDeviceIdTemporary = canonical.isDeviceIdTemporary;
export const hydrateDeviceId = canonical.hydrateDeviceId;
export const getCurrentDeviceLabel = canonical.getCurrentDeviceLabel;
export const getCurrentPlatform = canonical.getCurrentPlatform;

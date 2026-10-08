/** Required DB-IP attribution on every surface using coarse network geolocation. */
export function GeoAttribution() {
  return <p className="text-xs text-muted-foreground">
    Zone estimée avec les langues et le fuseau du navigateur, puis l’IP. Données IP :{' '}
    <a href="https://db-ip.com" target="_blank" rel="noopener noreferrer" className="underline">DB-IP</a>
    {' · '}<a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener noreferrer" className="underline">CC BY 4.0</a>
    {' · '}Ville/région approximatives, sans IP ni coordonnées enregistrées.
  </p>;
}

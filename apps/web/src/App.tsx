const supportedInputs = [
  "Telegram Mini App links",
  "TON Connect links",
  "TON addresses",
  "transaction JSON",
  "BOCs",
] as const;

export const App = () => (
  <main className="shell">
    <section className="hero">
      <p className="eyebrow">TON Shield</p>
      <h1>Telegram-native risk checks for TON interactions.</h1>
      <p className="lede">
        Paste a suspicious TON Connect request, Mini App link, Jetton address, or payload before
        trusting it.
      </p>
    </section>

    <section className="card" aria-labelledby="supported-inputs">
      <h2 id="supported-inputs">MVP scanner inputs</h2>
      <ul>
        {supportedInputs.map((input) => (
          <li key={input}>{input}</li>
        ))}
      </ul>
    </section>
  </main>
);

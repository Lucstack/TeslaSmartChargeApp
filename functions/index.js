// This is the main file for your Cloud Functions.
// It should be located at: /functions/index.js

const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onDocumentUpdated } = require("firebase-functions/v2/firestore");
// CORRECTED: HttpsError is imported directly
const {
  onRequest,
  onCall,
  HttpsError,
} = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const axios = require("axios");
const xml2js = require("xml2js");

admin.initializeApp();
const db = admin.firestore();

const entsoeApiKey = defineSecret("ENTSOE_API_KEY");
const teslaClientId = defineSecret("TESLA_CLIENT_ID");
const teslaClientSecret = defineSecret("TESLA_CLIENT_SECRET");

// CORRECTED: Defines the European API endpoint to be used everywhere
const TESLA_API_BASE_URL = "https://fleet-api.prd.eu.vn.cloud.tesla.com";

/**
 * [Function A] Fetches day-ahead electricity prices from the ENTSO-E API.
 */
exports.fetchEnergyPrices = onSchedule(
  {
    schedule: "10 1 * * *",
    timeZone: "Europe/Amsterdam",
    region: "europe-west1",
    secrets: [entsoeApiKey],
  },
  async (event) => {
    logger.info("Running fetchEnergyPrices function...");
    const REGION_CODE = "10YNL----------L";
    const ENTSOE_API_KEY = process.env.ENTSOE_API_KEY;

    try {
      const periodStart = new Date();
      periodStart.setHours(0, 0, 0, 0);
      const periodEnd = new Date(periodStart);
      periodEnd.setDate(periodEnd.getDate() + 1);

      const formatDate = (date) => {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, "0");
        const day = String(date.getDate()).padStart(2, "0");
        return `${year}${month}${day}0000`;
      };

      const apiUrl = `https://web-api.tp.entsoe.eu/api?securityToken=${ENTSOE_API_KEY}&documentType=A44&in_Domain=${REGION_CODE}&out_Domain=${REGION_CODE}&periodStart=${formatDate(
        periodStart
      )}&periodEnd=${formatDate(periodEnd)}`;

      const response = await axios.get(apiUrl);
      const xmlResponse = response.data;
      const parser = new xml2js.Parser({ explicitArray: true });
      const parsedData = await parser.parseStringPromise(xmlResponse);

      const timeSeries = parsedData.Publication_MarketDocument.TimeSeries;
      const relevantTimeSeries = timeSeries[timeSeries.length - 1];
      const period = relevantTimeSeries.Period[0];
      const points = period.Point;
      const periodStartTime = new Date(period.timeInterval[0].start[0]);
      const hourlyRates = {};
      points.forEach((point) => {
        const hour = parseInt(point.position[0], 10) - 1;
        const price = parseFloat(point["price.amount"][0]) / 1000;
        const pointTime = new Date(periodStartTime.getTime());
        pointTime.setHours(pointTime.getHours() + hour);
        hourlyRates[hour] = { price, time: pointTime.toISOString() };
      });

      await db.collection("energy_prices").doc("NL").set({
        lastUpdated: new Date(),
        hourlyRates: hourlyRates,
      });
      logger.info("Successfully fetched and saved energy prices for NL.");
    } catch (error) {
      logger.error("Error in fetchEnergyPrices:", error.message);
    }
  }
);

/**
 * [Function B] Calculates the optimal charging window for all users.
 */
exports.calculateOptimalWindow = onDocumentUpdated(
  { document: "energy_prices/NL", region: "europe-west1" },
  async (event) => {
    logger.info("Running calculateOptimalWindow function...");
    const hourlyRates = event.data.after.data().hourlyRates;
    if (!hourlyRates) return;

    const prices = Object.values(hourlyRates).map((rate) => rate.price);
    const usersSnapshot = await db.collection("users").get();
    if (usersSnapshot.empty) return;

    const batch = db.batch();
    usersSnapshot.forEach((userDoc) => {
      const userSettings = userDoc.data().settings;
      if (!userSettings || !userSettings.chargingDuration) return;

      const hoursNeeded = userSettings.chargingDuration;
      let bestStartHour = -1;
      let lowestAveragePrice = Infinity;

      for (let i = 0; i <= prices.length - hoursNeeded; i++) {
        const windowPrices = prices.slice(i, i + hoursNeeded);
        const averagePrice =
          windowPrices.reduce((a, b) => a + b, 0) / hoursNeeded;
        if (averagePrice < lowestAveragePrice) {
          lowestAveragePrice = averagePrice;
          bestStartHour = i;
        }
      }
      if (bestStartHour !== -1) {
        batch.update(userDoc.ref, {
          "settings.optimalStartHour": bestStartHour,
        });
      }
    });
    await batch.commit();
    logger.info("Finished calculating optimal windows for all users.");
  }
);

/**
 * [Function C] Receives real-time data from Tesla's Fleet Telemetry.
 */
exports.telemetryWebhook = onRequest(
  { region: "europe-west1" },
  async (req, res) => {
    const { vin, data } = req.body;
    if (!vin || !data) {
      res.status(400).send("Bad Request");
      return;
    }
    try {
      const snapshot = await db
        .collection("users")
        .where("vehicle.vin", "==", vin)
        .limit(1)
        .get();
      if (snapshot.empty) {
        res.status(200).send("OK");
        return;
      }
      const userDoc = snapshot.docs[0];
      const vehicleUpdate = {};
      if (data.charging_state)
        vehicleUpdate["vehicle.isCharging"] =
          data.charging_state === "Charging";
      if (data.charge_port_latch)
        vehicleUpdate["vehicle.isPluggedIn"] =
          data.charge_port_latch === "Engaged";
      if (data.battery_level)
        vehicleUpdate["vehicle.batteryLevel"] = data.battery_level;
      if (Object.keys(vehicleUpdate).length > 0) {
        await userDoc.ref.update(vehicleUpdate);
      }
      res.status(200).send("OK");
    } catch (error) {
      logger.error(`Error processing telemetry for VIN ${vin}:`, error);
      res.status(500).send("Internal Server Error");
    }
  }
);

/**
 * [Function D] Makes the charging decision for a user.
 */
exports.manageChargingLogic = onDocumentUpdated(
  {
    document: "users/{userId}",
    region: "europe-west1",
    secrets: [teslaClientId, teslaClientSecret],
  },
  async (event) => {
    const beforeData = event.data.before.data();
    const afterData = event.data.after.data();
    const userId = event.params.userId;

    if (
      afterData.chargeOverride === true &&
      beforeData.chargeOverride !== true
    ) {
      logger.info(`Manual override for ${userId}. Starting charge.`);
      try {
        await sendTeslaChargeCommand(
          afterData.teslaRefreshToken,
          afterData.vehicle.vin,
          "START"
        );
        await event.data.after.ref.update({ chargeOverride: false });
        logger.info(`Override successful, flag reset for ${userId}.`);
      } catch (error) {
        logger.error(`Error during manual override for ${userId}:`, error);
        await event.data.after.ref.update({ chargeOverride: false });
      }
      return;
    }

    if (
      beforeData.vehicle.isPluggedIn === false &&
      afterData.vehicle.isPluggedIn === true
    ) {
      logger.info(`Car plugged in for ${userId}. Running logic.`);
      // The rest of the smart charging logic can be added here.
    }
  }
);

/**
 * [Function E] Exchanges a Tesla auth code for a refresh token and fetches initial vehicle data.
 */
exports.exchangeAuthCodeForToken = onCall(
  { region: "europe-west1", secrets: [teslaClientId, teslaClientSecret] },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError(
        "unauthenticated",
        "The function must be called while authenticated."
      );
    }
    const authCode = request.data.code;
    if (!authCode) {
      throw new HttpsError(
        "invalid-argument",
        'The function must be called with a "code" argument.'
      );
    }
    const userId = request.auth.uid;
    logger.info(`Exchanging auth code for user ${userId}`);

    try {
      const response = await axios.post(
        "https://auth.tesla.com/oauth2/v3/token",
        {
          grant_type: "authorization_code",
          client_id: teslaClientId.value(),
          client_secret: teslaClientSecret.value(),
          code: authCode,
          audience: TESLA_API_BASE_URL,
          redirect_uri: "https://teslasmartchargeapp.web.app/callback",
        }
      );

      const refreshToken = response.data.refresh_token;
      if (!refreshToken) {
        throw new Error("Refresh token not found in Tesla response.");
      }

      const initialVehicleData = await getInitialVehicleData(refreshToken);

      await db.collection("users").doc(userId).update({
        teslaRefreshToken: refreshToken,
        "vehicle.vin": initialVehicleData.vin,
        "vehicle.batteryLevel": initialVehicleData.batteryLevel,
        "vehicle.isPluggedIn": initialVehicleData.isPluggedIn,
      });

      logger.info(
        `Successfully stored token and initial data for user ${userId}`
      );
      return { success: true, message: "Tesla account connected!" };
    } catch (error) {
      logger.error(
        `Error exchanging auth code for user ${userId}:`,
        error.response ? error.response.data : error.message
      );
      throw new HttpsError("internal", "Failed to connect to Tesla.");
    }
  }
);

/**
 * [Function F] Handles the OAuth redirect from Tesla.
 */
exports.handleTeslaRedirect = onRequest(
  { region: "europe-west1" },
  (req, res) => {
    const code = req.query.code;
    const state = req.query.state;
    if (!code) {
      res.status(400).send("Authorization code is missing.");
      return;
    }
    const redirectUrl = `teslasmartchargeapp://auth/callback?code=${code}&state=${state}`;
    res.redirect(redirectUrl);
  }
);

/**
 * [Function G] Fetches the latest vehicle data for an authenticated user.
 */
exports.refreshVehicleData = onCall(
  { region: "europe-west1", secrets: [teslaClientId, teslaClientSecret] },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError(
        "unauthenticated",
        "The function must be called while authenticated."
      );
    }
    const userId = request.auth.uid;
    logger.info(`Refreshing vehicle data for user ${userId}`);
    try {
      const userDoc = await db.collection("users").doc(userId).get();
      if (!userDoc.exists) {
        throw new HttpsError("not-found", "User not found.");
      }
      const refreshToken = userDoc.data().teslaRefreshToken;
      if (!refreshToken || refreshToken === "NEEDS_TO_BE_SET_LATER") {
        throw new HttpsError(
          "failed-precondition",
          "Tesla account not connected."
        );
      }
      const latestVehicleData = await getInitialVehicleData(refreshToken);
      await userDoc.ref.update({
        "vehicle.vin": latestVehicleData.vin,
        "vehicle.batteryLevel": latestVehicleData.batteryLevel,
        "vehicle.isPluggedIn": latestVehicleData.isPluggedIn,
      });
      logger.info(
        `Successfully refreshed and saved vehicle data for ${userId}`
      );
      return { success: true, message: "Vehicle data refreshed!" };
    } catch (error) {
      logger.error(`Error refreshing vehicle data for user ${userId}:`, error);
      throw new HttpsError("internal", "Failed to refresh vehicle data.");
    }
  }
);

// --- HELPER FUNCTIONS ---

async function getTeslaAccessToken(refreshToken) {
  const response = await axios.post("https://auth.tesla.com/oauth2/v3/token", {
    grant_type: "refresh_token",
    client_id: teslaClientId.value(),
    client_secret: teslaClientSecret.value(),
    refresh_token: refreshToken,
  });
  return response.data.access_token;
}

async function getInitialVehicleData(refreshToken) {
  const accessToken = await getTeslaAccessToken(refreshToken);

  const vehiclesResponse = await axios.get(
    `${TESLA_API_BASE_URL}/api/1/vehicles`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    }
  );

  if (
    !vehiclesResponse.data.response ||
    vehiclesResponse.data.response.length === 0
  ) {
    throw new Error("No vehicles found for this user.");
  }

  const vehicle = vehiclesResponse.data.response[0];
  const vehicleId = vehicle.id_s;

  const vehicleDataResponse = await axios.get(
    `${TESLA_API_BASE_URL}/api/1/vehicles/${vehicleId}/vehicle_data`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    }
  );

  const chargeState = vehicleDataResponse.data.response.charge_state;
  return {
    vin: vehicle.vin,
    batteryLevel: chargeState.battery_level,
    isPluggedIn: chargeState.charging_state !== "Disconnected",
  };
}

async function sendTeslaChargeCommand(refreshToken, vin, command) {
  try {
    const accessToken = await getTeslaAccessToken(refreshToken);
    const action = command === "START" ? "charge_start" : "charge_stop";
    logger.info(`Sending command '${action}' to VIN ${vin}`);
    // The actual API call is correctly commented out for safety.
  } catch (error) {
    logger.error(
      `Failed to send command to VIN ${vin}:`,
      error.response ? error.response.data : error.message
    );
  }
}

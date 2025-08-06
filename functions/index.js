// This is the main file for your Cloud Functions.
// It should be located at: /functions/index.js

// Import the necessary Firebase modules using the latest syntax.
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onDocumentUpdated } = require('firebase-functions/v2/firestore');
// CORRECTED: The correct function for HTTP triggers is onRequest.
const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');

// Import modules for making API requests and parsing XML.
const axios = require('axios');
const xml2js = require('xml2js');

// Initialize the Firebase Admin SDK.
admin.initializeApp();
const db = admin.firestore();

// Define secrets for our API keys.
const entsoeApiKey = defineSecret('ENTSOE_API_KEY');
const teslaClientId = defineSecret('TESLA_CLIENT_ID');
const teslaClientSecret = defineSecret('TESLA_CLIENT_SECRET');

/**
 * [Function A] Fetches day-ahead electricity prices from the ENTSO-E API.
 * Trigger: Runs on a schedule every day at 1:10 AM.
 */
exports.fetchEnergyPrices = onSchedule(
  {
    schedule: '10 1 * * *',
    timeZone: 'Europe/Amsterdam',
    region: 'europe-west1',
    secrets: [entsoeApiKey],
  },
  async event => {
    // Function logic remains the same...
  }
);

/**
 * [Function B] Calculates the optimal charging window for all users.
 * Trigger: Runs automatically whenever the energy price data is updated.
 */
exports.calculateOptimalWindow = onDocumentUpdated(
  'energy_prices/NL',
  async event => {
    // Function logic remains the same...
  }
);

/**
 * [Function C] Receives real-time data from Tesla's Fleet Telemetry.
 * Trigger: HTTP POST request from Tesla's servers.
 */
// CORRECTED: Use onRequest instead of onPost
exports.telemetryWebhook = onRequest(
  { region: 'europe-west1' },
  async (req, res) => {
    // Function logic remains the same...
  }
);

/**
 * [Function D] Makes the charging decision for a user.
 * Trigger: Runs whenever a user's vehicle status is updated in Firestore.
 */
exports.manageChargingLogic = onDocumentUpdated(
  {
    document: 'users/{userId}',
    region: 'europe-west1',
    secrets: [teslaClientId, teslaClientSecret],
  },
  async event => {
    const beforeData = event.data.before.data();
    const afterData = event.data.after.data();

    // Check if the car was just plugged in.
    if (
      beforeData.vehicle.isPluggedIn === false &&
      afterData.vehicle.isPluggedIn === true
    ) {
      logger.info(
        `Car plugged in for user ${event.params.userId}. Running charging logic.`
      );

      const { settings, vehicle, teslaRefreshToken } = afterData;
      const { optimalStartHour, emergencyThreshold, targetBattery } = settings;
      const { batteryLevel } = vehicle;

      try {
        // Get the current energy prices.
        const priceDoc = await db.collection('energy_prices').doc('NL').get();
        if (!priceDoc.exists) {
          throw new Error('Energy prices not found.');
        }
        const prices = priceDoc.data().hourlyRates;
        const currentHour = new Date().getHours();
        const currentPrice = prices[currentHour].price;

        // --- Decision Logic ---
        let decision = 'STOP'; // Default decision is to stop charging.

        // 1. Emergency Charging
        if (batteryLevel < emergencyThreshold) {
          decision = 'START';
          logger.info(
            `Decision for ${event.params.userId}: START (Emergency Charging)`
          );
        }
        // 2. Bonus Charging
        else if (currentPrice < 0) {
          decision = 'START';
          logger.info(
            `Decision for ${event.params.userId}: START (Bonus Charging)`
          );
        }
        // 3. Optimal Charging
        else if (
          currentHour >= optimalStartHour &&
          currentHour < optimalStartHour + settings.chargingDuration &&
          batteryLevel < targetBattery
        ) {
          decision = 'START';
          logger.info(
            `Decision for ${event.params.userId}: START (Optimal Window)`
          );
        } else {
          logger.info(
            `Decision for ${event.params.userId}: STOP (Outside optimal window)`
          );
        }

        // --- Execute Command ---
        await sendTeslaChargeCommand(teslaRefreshToken, vehicle.vin, decision);
      } catch (error) {
        logger.error(
          `Error in manageChargingLogic for user ${event.params.userId}:`,
          error
        );
      }
    }
  }
);

/**
 * Helper function to get a new Tesla access token using the refresh token.
 */
async function getTeslaAccessToken(refreshToken) {
  const response = await axios.post('https://auth.tesla.com/oauth2/v3/token', {
    grant_type: 'refresh_token',
    client_id: teslaClientId.value(),
    client_secret: teslaClientSecret.value(),
    refresh_token: refreshToken,
  });
  return response.data.access_token;
}

/**
 * Helper function to send a start or stop charging command to a Tesla vehicle.
 */
async function sendTeslaChargeCommand(refreshToken, vin, command) {
  try {
    const accessToken = await getTeslaAccessToken(refreshToken);
    const action = command === 'START' ? 'charge_start' : 'charge_stop';

    logger.info(`Sending command '${action}' to VIN ${vin}`);

    // This is a placeholder for the actual command.
    // The real command requires a more complex signed request.
    // For now, we will just log the action.
    // const response = await axios.post(`https://fleet-api.prd.na.vn.cloud.tesla.com/api/1/vehicles/${vin}/command/${action}`, {}, {
    //     headers: { 'Authorization': `Bearer ${accessToken}` }
    // });
    // logger.info(`Successfully sent command to VIN ${vin}`, response.data);
  } catch (error) {
    logger.error(
      `Failed to send command to VIN ${vin}:`,
      error.response ? error.response.data : error.message
    );
  }
}

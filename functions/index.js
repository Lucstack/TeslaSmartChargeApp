// This is the main file for your Cloud Functions.
// It should be located at: /functions/index.js

// Import the necessary Firebase modules using the latest syntax.
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onDocumentUpdated } = require('firebase-functions/v2/firestore');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');

// Import modules for making API requests and parsing XML.
const axios = require('axios');
const xml2js = require('xml2js');

// Initialize the Firebase Admin SDK.
admin.initializeApp();
const db = admin.firestore();

/**
 * [Function A] Fetches day-ahead electricity prices from the ENTSO-E API.
 * Trigger: Runs on a schedule every day at 1:10 AM.
 */
exports.fetchEnergyPrices = onSchedule(
  {
    schedule: '10 1 * * *',
    timeZone: 'Europe/Amsterdam',
    region: 'europe-west1',
    secrets: ['ENTSOE_API_KEY'],
  },
  async event => {
    logger.info('Running fetchEnergyPrices function...');
    const REGION_CODE = '10YNL----------L';
    const ENTSOE_API_KEY = process.env.ENTSOE_API_KEY;

    try {
      const periodStart = new Date();
      periodStart.setHours(0, 0, 0, 0);
      const periodEnd = new Date(periodStart);
      periodEnd.setDate(periodEnd.getDate() + 1);

      const formatDate = date => {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}${month}${day}0000`;
      };

      const apiUrl = `https://web-api.tp.entsoe.eu/api?securityToken=${ENTSOE_API_KEY}&documentType=A44&in_Domain=${REGION_CODE}&out_Domain=${REGION_CODE}&periodStart=${formatDate(
        periodStart
      )}&periodEnd=${formatDate(periodEnd)}`;

      logger.info(`Fetching data from ENTSO-E API...`);
      const response = await axios.get(apiUrl);
      const xmlResponse = response.data;

      const parser = new xml2js.Parser({ explicitArray: true });
      const parsedData = await parser.parseStringPromise(xmlResponse);

      const timeSeries = parsedData.Publication_MarketDocument.TimeSeries;
      if (!timeSeries || timeSeries.length === 0) {
        throw new Error('No TimeSeries data found in the API response.');
      }

      const relevantTimeSeries = timeSeries[timeSeries.length - 1];
      const period = relevantTimeSeries.Period[0];
      const points = period.Point;

      if (!points || points.length === 0) {
        throw new Error('No price points found in the relevant TimeSeries.');
      }

      const periodStartTime = new Date(period.timeInterval[0].start[0]);
      const hourlyRates = {};
      points.forEach(point => {
        const hour = parseInt(point.position[0], 10) - 1;
        const price = parseFloat(point['price.amount'][0]) / 1000;

        const pointTime = new Date(periodStartTime.getTime());
        pointTime.setHours(pointTime.getHours() + hour);

        hourlyRates[hour] = {
          price: price,
          time: pointTime.toISOString(),
        };
      });

      const priceData = {
        lastUpdated: new Date(),
        hourlyRates: hourlyRates,
      };

      await db.collection('energy_prices').doc('NL').set(priceData);
      logger.info('Successfully fetched and saved energy prices for NL.', {
        numberOfRates: Object.keys(hourlyRates).length,
      });
    } catch (error) {
      logger.error('Error in fetchEnergyPrices:', error.message);
    }
  }
);

/**
 * [Function B] Calculates the optimal charging window for all users.
 * Trigger: Runs automatically whenever the energy price data is updated.
 */
exports.calculateOptimalWindow = onDocumentUpdated(
  'energy_prices/NL',
  async event => {
    logger.info(
      'Running calculateOptimalWindow function because prices were updated.'
    );

    const priceData = event.data.after.data();
    const hourlyRates = priceData.hourlyRates;

    if (!hourlyRates) {
      logger.error('No hourlyRates found in the price data.');
      return;
    }

    const prices = Object.values(hourlyRates).map(rate => rate.price);

    // Get all users from the database.
    const usersSnapshot = await db.collection('users').get();
    if (usersSnapshot.empty) {
      logger.info('No users found in the database. Exiting function.');
      return;
    }

    // Create a batch to perform all database updates at once.
    const batch = db.batch();

    // Loop through each user to calculate their optimal window.
    usersSnapshot.forEach(userDoc => {
      const userData = userDoc.data();
      const userSettings = userData.settings;

      if (!userSettings || !userSettings.chargingDuration) {
        logger.warn(`User ${userDoc.id} has no settings. Skipping.`);
        return;
      }

      const hoursNeeded = userSettings.chargingDuration;
      let bestStartHour = -1;
      let lowestAveragePrice = Infinity;

      // This is the same logic from your Python script to find the cheapest window.
      for (
        let startHour = 0;
        startHour <= prices.length - hoursNeeded;
        startHour++
      ) {
        const windowPrices = prices.slice(startHour, startHour + hoursNeeded);
        const averagePrice =
          windowPrices.reduce((a, b) => a + b, 0) / hoursNeeded;

        if (averagePrice < lowestAveragePrice) {
          lowestAveragePrice = averagePrice;
          bestStartHour = startHour;
        }
      }

      if (bestStartHour !== -1) {
        logger.info(
          `Optimal window for user ${userDoc.id} is ${hoursNeeded} hours starting at ${bestStartHour}:00.`
        );

        // Add an update operation to the batch.
        const userRef = db.collection('users').doc(userDoc.id);
        batch.update(userRef, {
          'settings.optimalStartHour': bestStartHour,
        });
      }
    });

    // Commit the batch to save all the updates.
    await batch.commit();
    logger.info(
      'Finished calculating and saving optimal windows for all users.'
    );
  }
);

/* @flow */
import 'cross-fetch/polyfill'

import { lookupProfile, config as bskConfig } from 'blockstack'
import logger from 'winston'
import { Collection } from 'mongodb'
import fs from 'fs'
import path from 'path'

type IndexEntry = { key: string, value: Object }

const BATCH_DELAY = process.env.BSK_SEARCH_WAIT_BETWEEN_QUERIES || 0;
const BATCH_SIZE  = process.env.BSK_SEARCH_BATCH_SIZE || 5;

function _getAllNames(page: number, priorNames: Array<string>, pagesToFetch: number): Promise<Array<string>> {
  const blockstackAPIUrl = bskConfig.network.blockstackAPIUrl
  const fetchUrl = `${blockstackAPIUrl}/v1/names?page=${page}`

  if (pagesToFetch && pagesToFetch > 0 && page >= pagesToFetch) {
    return priorNames
  }

  if (page % 20 === 0) {
    logger.info(`Fetched ${page} domain pages...`)
  }

  return fetch(fetchUrl)
    .then(resp => resp.json())
    .then(names => {
      logger.debug('Fetched name page')
      if (names.length > 0) {
        names.forEach(x => priorNames.push(x))
        return _getAllNames(page + 1, priorNames, pagesToFetch)
      } else {
        return priorNames
      }
    })
}

function _getAllSubdomains(page: number, priorNames: Array<string>, pagesToFetch: number): Promise<Array<string>> {
  const blockstackAPIUrl = bskConfig.network.blockstackAPIUrl
  const fetchUrl = `${blockstackAPIUrl}/v1/subdomains?page=${page}`

  if (pagesToFetch && pagesToFetch > 0 && page >= pagesToFetch) {
    return priorNames
  }

  if (page % 20 === 0) {
    logger.info(`Fetched ${page} subdomain pages...`)
  }

  return fetch(fetchUrl)
    .then(resp => resp.json())
    .then(names => {
      logger.debug('Fetched subdomain page')
      if (names.length > 0) {
        names.forEach(x => priorNames.push(x))
        return _getAllSubdomains(page + 1, priorNames, pagesToFetch)
      } else {
        return priorNames
      }
    })
}

function getAllNames(pagesToFetch: number): Promise<Array<string>> {
  return _getAllNames(0, [], pagesToFetch)
}

function getAllSubdomains(pagesToFetch: number): Promise<Array<string>> {
  return _getAllSubdomains(0, [], pagesToFetch)
}

function cleanEntry(entry: Object): Object {
  if (!entry) {
    return entry
  }
  Object.keys(entry)
    .forEach((key) => {
      const value = entry[key]
      if (typeof(value) === 'object') {
        cleanEntry(value)
      }
      if (key.includes('.')) {
        const newKey = key.replace(/\./g, '_')
        entry[newKey] = value
        delete entry[key]
        key = newKey
      }
      if (key.startsWith('$')) {
        entry['_' + key.slice(1)] =  value
        delete entry[key]
      }
    })

  return entry
}

function promiseTimer(timeout: number): Promise<Void> {
  return new Promise((resolve, reject) =>
                     setTimeout(() => resolve(), timeout))
}

async function lookupProfileWithTimeout(name: string, timeoutSecs: number): Promise<Object> {
  let result = await Promise.race([
    new Promise((resolve, reject) =>
                setTimeout(() => reject(new Error('lookupProfile timed out')),
                           timeoutSecs*1000)),
    lookupProfile(name)])
  return result
}

async function fetchName(name: string) : Promise<?IndexEntry> {
    try {
      let profile = await lookupProfileWithTimeout(name, 30)
      let result = { key: name,
                     value: cleanEntry(Object.assign({}, profile)) }
      return result
    } catch (err) {
      logger.debug(`Failed looking up profile for ${name}`)
      logger.debug(err)
      return null
    }
}

async function fetchNames(names: Array<string>, batchSize) : Promise<Array<?IndexEntry>> {
  let batch = []
  let profiles = []
  let errorCount = 0
  let ix = 0
  for (const name of names) {
    if (batch.length >= batchSize) {
      let results = await Promise.all(batch.map(fetchName));
      results.forEach(result => {
        if (result) {
          profiles.push({ profile: result.value,
                          fqu: result.key })
        } else {
          errorCount += 1
        }
      })
      logger.info(`Fetched ${ix} entries`)
      let timeout = BATCH_DELAY
      await promiseTimer(timeout)

      batch = []
    }
    ix += 1;
    batch.push(name)
  }
  if (batch.length > 0) {
    let results = await Promise.all(batch.map(fetchName));
    results.forEach(result => {
      if (result) {
        profiles.push({ profile: result.value,
                        fqu: result.key })
      } else {
        errorCount += 1
      }
    })
  }

  return [profiles, errorCount]
}

function ensureExists(filename) {
  if (fs.existsSync(filename)) {
    try {
      fs.accessSync(filename, fs.constants.W_OK)
    } catch (err) {
      throw new Error(`Cannot write to path: ${filename}`)
    }
  }
  const dirname = path.dirname(filename)
  if (fs.existsSync(dirname)) {
    try {
      fs.accessSync(dirname, fs.constants.W_OK)
    } catch (err) {
      throw new Error(`Cannot write to path: ${dirname}`)
    }
  } else {
    ensureExists(dirname)
    fs.mkdirSync(dirname)
  }
}

function _fetchAllNames(pagesToFetch: number):
  Promise<{ names: [string], profiles: [{ profile: Object, fqu: string }] }> {
  const profiles = []
  const names = []
  let errorCount = 0

  return Promise.all([getAllNames(pagesToFetch), getAllSubdomains(pagesToFetch)])
    .then(([allDomains, allSubdomains]) => {
      const totalLength = allDomains.length + allSubdomains.length
      logger.info(`Fetching ${totalLength} entries`)
      allDomains.forEach( x => names.push(x) )
      allSubdomains.forEach( x => names.push(x) )
      return names
    })
    .then(names => fetchNames(names, BATCH_SIZE))
    .then(([profiles, errorCount]) => {
      logger.info(`Total errored lookups: ${errorCount}`)
      logger.info('Finished batching. Writing...')
      return { names, profiles }
    })
}

export function dumpAllNamesFile(profilesFile: string, namesFile: string, options: any = {}): Promise<void> {

  ensureExists(profilesFile)
  ensureExists(namesFile)

  return _fetchAllNames(options.pagesToFetch)
    .then((result) => {
      fs.writeFileSync(profilesFile, JSON.stringify(result.profiles, null, 2))
      fs.writeFileSync(namesFile, JSON.stringify(result.names, null, 2))
    })
}

export function processAllNames(namespaceCollection: Collection,
                                profileCollection: Collection,
                                options: any = {}): Promise<void> {
  const fetchingPromise = options.useFiles ?
        Promise.resolve(
          { names: JSON.parse(fs.readFileSync(options.useFiles.namespace)),
            profiles: JSON.parse(fs.readFileSync(options.useFiles.profiles)) })
        : _fetchAllNames(options.pagesToFetch)

  return fetchingPromise
    .then((results) => {
      const { profiles } = results
      // fetch_profile_data_from_file in old python version
      return Promise.all(profiles.map(entry => profileCollection.save({ key: entry.fqu,
                                                                        value: cleanEntry(entry.profile)})))
      // fetch_namespace_from_file in old python version
        .then(() => Promise.all(profiles.map(entry => {
          try {
            let username = entry.fqu
            if (username.endsWith('.id')) {
              username = username.slice(0, -3)
            }
            const newEntry = { username,
                               fqu: entry.fqu,
                               profile: cleanEntry(entry.profile) }
            return namespaceCollection.save(newEntry)
          } catch (err) {
            logger.warn(`Error processing ${entry.key}`)
            logger.warn(err)
          }
        })))
    })
}

export function createSearchIndex(namespaceCollection: Collection, searchProfiles: Collection,
                                  peopleCache: Collection, twitterCache: Collection,
                                  usernameCache: Collection): Promise<void> {
  const cursor = namespaceCollection.find()
  const peopleNames = []
  const twitterHandles = []
  const usernames = []
  const errors = []
  return cursor.forEach(
    (user) => {
      try {
        let openbazaar = null
        let name = null
        let twitterHandle = null
        const profile = user.profile
        if (profile.account) {
          profile.account.forEach((account) => {
            if (account.service === 'openbazaar') {
              openbazaar = account.identifier
            } else if (account.service === 'twitter') {
                twitterHandle = account.identifier
            }
          })
        }
        if (profile.name) {
          name = profile.name
          if (name.formatted) {
            name = name.formatted
          }
          name = name.toLocaleLowerCase()
        }

        if (name) {
          peopleNames.push(name)
        }
        if (twitterHandle) {
          twitterHandles.push(twitterHandle)
        }
        if (user.fqu) {
          usernames.push(user.fqu)
        }

        const entry = { name, profile, openbazaar,
                        'twitter_handle': twitterHandle,
                        username: user.username,
                        fullyQualifiedName: user.fqu }
        searchProfiles.save(entry)
      } catch (err) {
        errors.push(user.fqu)
      }
    })
    .then(() => {
      logger.warn(`Errors on names: ${JSON.stringify(errors)}`)
      const peopleNamesSet = new Set(peopleNames)
      const twitterHandlesSet = new Set(twitterHandles)
      const usernamesSet = new Set(usernames)
      const peopleNamesEntry = { name: [...peopleNamesSet] }
      const twitterHandlesEntry = { 'twitter_handle': [...twitterHandlesSet] }
      const usernamesEntry = { username: [...usernamesSet] }
      return peopleCache.save(peopleNamesEntry)
        .then(() => twitterCache.save(twitterHandlesEntry))
        .then(() => usernameCache.save(usernamesEntry))
    })
    .then(() => {
      // optimize_db()
      peopleCache.ensureIndex({'name': 1})
    })
}

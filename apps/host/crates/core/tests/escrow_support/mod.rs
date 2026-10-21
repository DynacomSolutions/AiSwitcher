#![allow(dead_code)]
use ais_host_core::{
    escrow::{Clock, EscrowDelete, EscrowError, EscrowStore, ExposeSecret, ItemRef, SecretString},
    registry::{RegistryData, RegistryStorage},
};
use std::{cell::Cell, collections::HashMap, rc::Rc};

pub const DRIVE: &str = "SYNTHETIC_FIXTURE_drive";
pub const PASSPHRASE: &str = "SYNTHETIC_FIXTURE retained passphrase";
pub fn secret() -> SecretString {
    SecretString::from(PASSPHRASE)
}

#[derive(Clone)]
pub struct FakeClock {
    pub wall: Rc<Cell<u64>>,
    pub mono: Rc<Cell<u64>>,
}
impl FakeClock {
    pub fn new(wall: u64) -> Self {
        Self {
            wall: Rc::new(Cell::new(wall)),
            mono: Rc::new(Cell::new(0)),
        }
    }
    pub fn advance(&self, seconds: u64) {
        self.wall.set(self.wall.get() + seconds);
        self.mono.set(self.mono.get() + seconds);
    }
}
impl Clock for FakeClock {
    fn wall_seconds(&self) -> u64 {
        self.wall.get()
    }
    fn monotonic_seconds(&self) -> u64 {
        self.mono.get()
    }
}

pub struct MemoryRegistry {
    pub data: RegistryData,
    pub saves: usize,
    pub fail_save: Option<usize>,
}
impl Default for MemoryRegistry {
    fn default() -> Self {
        Self {
            data: RegistryData::new().unwrap(),
            saves: 0,
            fail_save: None,
        }
    }
}
impl RegistryStorage for MemoryRegistry {
    fn load(&mut self) -> Result<RegistryData, EscrowError> {
        Ok(self.data.clone())
    }
    fn save(&mut self, data: &RegistryData) -> Result<(), EscrowError> {
        data.validate()?;
        self.saves += 1;
        if self.fail_save == Some(self.saves) {
            return Err(EscrowError::RegistryUnavailable);
        }
        self.data = data.clone();
        Ok(())
    }
}

#[derive(Default)]
pub struct FakeStore {
    pub values: HashMap<String, SecretString>,
    pub puts: usize,
    pub gets: usize,
    pub deletes: usize,
    pub locked: bool,
    pub fail_delete: bool,
    pub fail_put_after_write: bool,
    pub delay_get: Option<(FakeClock, u64)>,
}
fn key(item: &ItemRef) -> String {
    serde_json::to_string(item).unwrap()
}
impl EscrowDelete for FakeStore {
    fn delete(&mut self, item: &ItemRef) -> Result<(), EscrowError> {
        self.deletes += 1;
        if self.locked || self.fail_delete {
            return Err(EscrowError::Locked);
        }
        self.values.remove(&key(item));
        Ok(())
    }
}
impl EscrowStore for FakeStore {
    fn put(&mut self, item: &ItemRef, secret: &SecretString) -> Result<(), EscrowError> {
        self.puts += 1;
        if self.locked {
            return Err(EscrowError::Locked);
        }
        self.values
            .insert(key(item), SecretString::from(secret.expose_secret()));
        if self.fail_put_after_write {
            return Err(EscrowError::Unavailable);
        }
        Ok(())
    }
    fn retrieve(&mut self, item: &ItemRef) -> Result<SecretString, EscrowError> {
        self.gets += 1;
        if self.locked {
            return Err(EscrowError::Locked);
        }
        if let Some((clock, seconds)) = &self.delay_get {
            clock.advance(*seconds);
        }
        self.values
            .get(&key(item))
            .map(|value| SecretString::from(value.expose_secret()))
            .ok_or(EscrowError::Missing)
    }
}
